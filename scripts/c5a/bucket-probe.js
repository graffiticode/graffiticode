// C5a Step 28: a one-off probe of the gate and staging buckets' access, run as
// the identity whose access is checked (docs/capability-policy-iam-review.md,
// Step 28). It makes the same JSON API calls Policy (packages/policy/src/
// staging.ts) and Broker (packages/broker/src/gcs.ts) make, under a probe
// prefix, and checks each answer's status against the step's expectation:
//
//   --as policy (job as policy-run), on the staging bucket:
//     create-once     POST, ifGenerationMatch=0            200
//     create-again    the same name, ifGenerationMatch=0    412  (create-once holds)
//     read            GET alt=media                         200  (adoption)
//     overwrite       the same name, ifGenerationMatch=<g>  403  (no delete: immutable)
//     delete          DELETE                                403
//     gate-read       GET metadata on the gate bucket       403  (staging only)
//   --as broker (job as broker-run):
//     staging-read    GET alt=media of the policy probe's object   200
//     staging-create  POST on the staging bucket            403
//     gate-create     POST on the gate bucket, ifGenerationMatch=0  200
//     gate-metadata   GET fields=generation,metadata        200
//     gate-stale      overwrite with a stale generation     412
//     gate-overwrite  overwrite with the current generation 200  (objectUser deletes)
//
// It prints one line, `C5A-BUCKET-PROBE <json>`, with each call's status and
// nothing else from the responses. Tokens come from the metadata server and
// are never printed. Plain Node 22, no dependencies, CommonJS (runs with
// `node -e`). The probe objects stay under `c5a-probe/`; the operator deletes
// them afterwards (the staging bucket's lifecycle would in 30 days).
//
//   PROBE_AS             policy | broker
//   PROBE_STAGING        the staging bucket
//   PROBE_GATE           the gate bucket
//   PROBE_RUN            a run label shared by both jobs (names the objects)

const TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const EMAIL_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email";
const API = "https://storage.googleapis.com";

const metadata = async url => {
  const res = await fetch(url, { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) throw new Error(`metadata answered ${res.status}`);
  return res.text();
};

const objectUrl = (bucket, name) => `${API}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}`;
const uploadUrl = (bucket, name, generation) =>
  `${API}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(name)}&ifGenerationMatch=${encodeURIComponent(generation)}&fields=generation`;

const main = async () => {
  const as = process.env.PROBE_AS;
  const staging = process.env.PROBE_STAGING;
  const gate = process.env.PROBE_GATE;
  const run = process.env.PROBE_RUN;
  if (!["policy", "broker"].includes(as) || !staging || !gate || !/^[a-z0-9-]{1,40}$/.test(run ?? "")) throw new Error("PROBE_AS, PROBE_STAGING, PROBE_GATE and PROBE_RUN are required");
  const token = JSON.parse(await metadata(TOKEN_URL)).access_token;
  const email = (await metadata(EMAIL_URL)).trim();
  const auth = { Authorization: `Bearer ${token}` };
  const bytes = Buffer.from(`c5a bucket probe ${run}\n`);
  const create = (bucket, name, generation) => fetch(uploadUrl(bucket, name, generation), { method: "POST", headers: { ...auth, "Content-Type": "text/plain" }, body: bytes });
  const checks = [];
  const check = async (id, expect, request) => {
    const res = await request();
    let generation = null;
    if (res.ok) {
      try {
        generation = (await res.clone().json()).generation ?? null;
      } catch {
        generation = null;
      }
    }
    checks.push({ id, expect, status: res.status, ok: res.status === expect });
    return generation;
  };
  const stagingName = `c5a-probe/${run}/staged.txt`;
  const gateName = `c5a-probe/${run}/published.txt`;
  if (as === "policy") {
    const g = await check("create-once", 200, () => create(staging, stagingName, "0"));
    await check("create-again", 412, () => create(staging, stagingName, "0"));
    await check("read", 200, () => fetch(`${objectUrl(staging, stagingName)}?alt=media`, { headers: auth }));
    await check("overwrite", 403, () => create(staging, stagingName, g ?? "1"));
    await check("delete", 403, () => fetch(objectUrl(staging, stagingName), { method: "DELETE", headers: auth }));
    await check("gate-read", 403, () => fetch(`${objectUrl(gate, gateName)}?fields=generation`, { headers: auth }));
  } else {
    await check("staging-read", 200, () => fetch(`${objectUrl(staging, stagingName)}?alt=media`, { headers: auth }));
    await check("staging-create", 403, () => create(staging, `c5a-probe/${run}/broker.txt`, "0"));
    const g1 = await check("gate-create", 200, () => create(gate, gateName, "0"));
    await check("gate-metadata", 200, () => fetch(`${objectUrl(gate, gateName)}?fields=generation,metadata`, { headers: auth }));
    await check("gate-stale", 412, () => create(gate, gateName, "1"));
    await check("gate-overwrite", 200, () => create(gate, gateName, g1 ?? "0"));
  }
  const out = { at: new Date().toISOString(), execution: process.env.CLOUD_RUN_EXECUTION ?? null, as, email, run, staging, gate, checks, passed: checks.every(c => c.ok) };
  console.log(`C5A-BUCKET-PROBE ${JSON.stringify(out)}`);
  if (!out.passed) process.exitCode = 1;
};

main().catch(e => {
  console.log(`C5A-BUCKET-PROBE ${JSON.stringify({ error: String(e?.message ?? e) })}`);
  process.exitCode = 1;
});
