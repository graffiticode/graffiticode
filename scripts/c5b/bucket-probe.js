// C5b Step 30: a probe of graffiticode-thumbnails' access, run as the identity
// whose access is checked (docs/capability-policy-iam-review.md, Step 30;
// docs/c5b-thumbnails-bucket-plan.md, slice 1). It makes the JSON API calls
// Broker makes (packages/broker/src/gcs.ts), under c5b-probe/<run>/, and
// checks each answer's status:
//
//   --as broker (job as broker-run):
//     a-create        POST a.png, ifGenerationMatch=0                 200
//     a-metadata      GET fields=generation,metadata                  200
//     a-stale         overwrite a.png with a stale generation         412
//     a-overwrite     overwrite a.png with the current generation     200  (objectUser deletes)
//     b-create        POST b.png, ifGenerationMatch=0                 200
//     b-delete        DELETE b.png                                    204
//     staging-create  POST on the staging bucket                      403  (unchanged)
//     a.png is left in place for the anonymous checks.
//   --as policy (job as policy-run), --as l0013r (job as l0013r-run):
//     create          POST on the thumbnails bucket                   403
//   --as anonymous (the operator's machine, no credentials at all), after
//   the broker job:
//     a-read          GET storage.googleapis.com/<bucket>/c5b-probe/<run>/a.png   200
//     b-read          the same for the deleted b.png                              404
//     list-json       GET storage/v1/b/<bucket>/o                                 401 or 403
//     list-xml        GET storage.googleapis.com/<bucket>                         401 or 403
//
// It prints one line, `C5B-BUCKET-PROBE <json>`, with each call's status and
// nothing else from the responses. Job tokens come from the metadata server
// and are never printed. Plain Node 22, no dependencies, CommonJS (runs with
// `node -e`). The operator removes a.png afterwards, explicitly.
//
//   PROBE_AS         broker | policy | l0013r | anonymous
//   PROBE_BUCKET     the thumbnails bucket
//   PROBE_STAGING    the staging bucket (broker only)
//   PROBE_RUN        a run label shared by every probe (names the objects)
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
const publicUrl = (bucket, name) => `${API}/${bucket}/${name.split("/").map(encodeURIComponent).join("/")}`;

const main = async () => {
  const as = process.env.PROBE_AS;
  const bucket = process.env.PROBE_BUCKET;
  const staging = process.env.PROBE_STAGING;
  const run = process.env.PROBE_RUN;
  if (!["broker", "policy", "l0013r", "anonymous"].includes(as) || !bucket || !/^[a-z0-9-]{1,40}$/.test(run ?? "") || (as === "broker" && !staging)) {
    throw new Error("PROBE_AS, PROBE_BUCKET and PROBE_RUN are required (and PROBE_STAGING as broker)");
  }
  const anonymous = as === "anonymous";
  const auth = anonymous ? {} : { Authorization: `Bearer ${JSON.parse(await metadata(TOKEN_URL)).access_token}` };
  const email = anonymous ? null : (await metadata(EMAIL_URL)).trim();
  const bytes = Buffer.from(`c5b bucket probe ${run}\n`);
  const create = (b, name, generation) => fetch(uploadUrl(b, name, generation), { method: "POST", headers: { ...auth, "Content-Type": "image/png" }, body: bytes });
  const checks = [];
  const check = async (id, expect, request) => {
    const res = await request();
    let generation = null;
    if (res.ok && res.status !== 204) {
      try {
        generation = (await res.clone().json()).generation ?? null;
      } catch {
        generation = null;
      }
    }
    const ok = Array.isArray(expect) ? expect.includes(res.status) : res.status === expect;
    checks.push({ id, expect, status: res.status, ok });
    return generation;
  };
  const a = `c5b-probe/${run}/a.png`;
  const b = `c5b-probe/${run}/b.png`;
  if (as === "broker") {
    const g1 = await check("a-create", 200, () => create(bucket, a, "0"));
    await check("a-metadata", 200, () => fetch(`${objectUrl(bucket, a)}?fields=generation,metadata`, { headers: auth }));
    await check("a-stale", 412, () => create(bucket, a, "1"));
    await check("a-overwrite", 200, () => create(bucket, a, g1 ?? "0"));
    await check("b-create", 200, () => create(bucket, b, "0"));
    await check("b-delete", 204, () => fetch(objectUrl(bucket, b), { method: "DELETE", headers: auth }));
    await check("staging-create", 403, () => create(staging, `c5b-probe/${run}/broker.png`, "0"));
  } else if (as === "anonymous") {
    await check("a-read", 200, () => fetch(publicUrl(bucket, a)));
    await check("b-read", 404, () => fetch(publicUrl(bucket, b)));
    await check("list-json", [401, 403], () => fetch(`${API}/storage/v1/b/${encodeURIComponent(bucket)}/o?maxResults=1`));
    await check("list-xml", [401, 403], () => fetch(`${API}/${bucket}`));
  } else {
    await check("create", 403, () => create(bucket, `c5b-probe/${run}/${as}.png`, "0"));
  }
  const out = { at: new Date().toISOString(), execution: process.env.CLOUD_RUN_EXECUTION ?? null, as, email, run, bucket, checks, passed: checks.every(c => c.ok) };
  console.log(`C5B-BUCKET-PROBE ${JSON.stringify(out)}`);
  if (!out.passed) process.exitCode = 1;
};

main().catch(e => {
  console.log(`C5B-BUCKET-PROBE ${JSON.stringify({ error: String(e?.message ?? e) })}`);
  process.exitCode = 1;
});
