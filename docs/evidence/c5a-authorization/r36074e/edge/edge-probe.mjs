// The C5a edge-cache probes (procedure rev 3), run r36074e: anonymous,
// redirects off, every response recorded separately with its headers and body
// digest. The camera's exact URLs are primed: A1' (its /form, no lang) and A2
// (the View's data URL), beside A1.
//   node edge-probe.mjs <step> <outdir>   step: p1 | e1 | e2 | e4-watch
// e4-watch: started before --phase captures; waits for a generation of the
// private item's gate object other than the one it starts from (argv[4]),
// records whose capture it is, then probes A1, A1' and A2 twice each.
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

const [step, outdir] = process.argv.slice(2);
const fixtures = JSON.parse(readFileSync("/Users/jeffdyer/work/graffiticode/graffiticode-c6r/.gc-deploy/c5a-gate/fixtures.json", "utf8"));
const T = fixtures.created.privateSheetTask.id;
const Tp = fixtures.created.publicSheetTask.id;
const API = "https://api.graffiticode.org";
const GEN = "%40L0179%3Dinterp-4";
const A1 = `${API}/form?id=${T}&lang=0179`;
// The camera's own /form URL (no lang), observed in E3's request log.
const A1P = `${API}/form?id=${T}`;
const A2 = `${API}/data?id=${T}&generations=${GEN}`;
const P1 = `${API}/form?id=${Tp}&lang=0179`;
const HEADERS = ["cache-control", "cf-cache-status", "age", "vary", "expires", "cf-ray", "date", "location", "content-type"];

const probe = async (label, url) => {
  const res = await fetch(url, { redirect: "manual", headers: { "User-Agent": "c5a-edge-probe" } });
  const body = Buffer.from(await res.arrayBuffer());
  const headers = Object.fromEntries(HEADERS.map(h => [h, res.headers.get(h)]).filter(([, v]) => v !== null));
  const r = { label, url, at: new Date().toISOString(), status: res.status, headers, bodyBytes: body.length, bodySha256: createHash("sha256").update(body).digest("hex") };
  console.log(JSON.stringify(r));
  return r;
};

const PRIVATE_OK = r => {
  const problems = [];
  if (!/no-store/.test(r.headers["cache-control"] ?? "")) problems.push("no no-store");
  const cf = r.headers["cf-cache-status"];
  if (cf && !["BYPASS", "DYNAMIC"].includes(cf)) problems.push(`cf-cache-status ${cf}`);
  if (r.headers.age) problems.push(`age ${r.headers.age}`);
  if (r.status < 400) problems.push(`status ${r.status}`);
  if (r.headers.location) problems.push("redirected");
  return problems;
};

const out = [];
if (step === "p1") {
  const p1 = await probe("P1", P1);
  out.push(p1);
  const loc = p1.headers.location ?? null;
  const dataUrl = loc ? new URL(loc).searchParams.get("url") : null;
  const expected = `${API}/data?id=${Tp}&generations=${GEN}`;
  const check = { location: loc, dataUrl, expectedShape: expected, matches: dataUrl === expected, a2: A2 };
  // The data URL as it appears raw in Location (before URLSearchParams decoding), for the byte-for-byte shape.
  check.rawUrlParam = loc ? (loc.split(/[?&]url=/)[1] ?? "").split("&")[0] : null;
  console.log(JSON.stringify({ check }));
  out.push({ check });
  if (loc) {
    out.push(await probe("P1-loc #1", loc));
    out.push(await probe("P1-loc #2", loc));
  }
  if (dataUrl) {
    out.push(await probe("P1-data #1", dataUrl));
    out.push(await probe("P1-data #2", dataUrl));
  }
} else if (step === "e1" || step === "e2") {
  for (const [label, url] of [[`${step.toUpperCase()} A1`, A1], [`${step.toUpperCase()} A1'`, A1P], [`${step.toUpperCase()} A2`, A2]]) {
    const r = await probe(label, url);
    r.problems = PRIVATE_OK(r);
    out.push(r);
  }
} else if (step === "e1p" || step === "e2p") {
  const r = await probe(`${step.toUpperCase()} A1'`, A1P);
  r.problems = PRIVATE_OK(r);
  out.push(r);
} else if (step === "e4-watch") {
  const { execFileSync } = await import("node:child_process");
  const FROM = process.argv[4];
  if (!FROM) throw new Error("e4-watch needs the starting generation");
  const object = `gs://graffiticode-c5a-gate/${fixtures.created.privateItem.id}.png`;
  const describe = () => JSON.parse(execFileSync("gcloud", ["storage", "objects", "describe", object, "--format=json", "--project=graffiticode"], { stdio: ["ignore", "pipe", "ignore"] }).toString());
  const start = describe();
  if (String(start.generation) !== FROM) throw new Error(`object is at generation ${start.generation}, not ${FROM}`);
  console.log(`watching ${object} from generation ${FROM}`);
  const until = Date.now() + 60 * 60_000;
  let meta = null;
  while (!meta && Date.now() < until) {
    try {
      const m = describe();
      if (String(m.generation) !== FROM) meta = m;
    } catch { /* transient */ }
    if (!meta) await new Promise(r => setTimeout(r, 2_000));
  }
  if (!meta) throw new Error(`no new generation of ${object} within 60 min`);
  const seenAt = new Date().toISOString();
  out.push({ published: { object, fromGeneration: FROM, generation: meta.generation ?? null, created: meta.creation_time ?? null, custom: meta.custom_fields ?? meta.metadata ?? null, seenAt } });
  for (const n of [1, 2]) {
    for (const [label, url] of [[`E4 A1 #${n}`, A1], [`E4 A1' #${n}`, A1P], [`E4 A2 #${n}`, A2]]) {
      const r = await probe(label, url);
      r.problems = PRIVATE_OK(r);
      out.push(r);
    }
  }
} else {
  throw new Error("step: p1 | e1 | e2 | e4-watch");
}
mkdirSync(outdir, { recursive: true });
writeFileSync(`${outdir}/${step}.json`, `${JSON.stringify(out, null, 2)}\n`);
