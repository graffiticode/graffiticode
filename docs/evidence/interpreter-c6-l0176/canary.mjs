// C6 part 2 canary: a staged api (tag URL) interpreting L0176, against production (legacy path).
// node docs/evidence/interpreter-c6-l0176/canary.mjs <stagedBase> <stagedRevision>
// docs/c6-l0176-reads-plan.md §7 step 4. Reads the staged revision's own stage records and
// /preview/sign routing records from Cloud Logging (the operator's gcloud). Anonymous throughout: no
// connection, so every read is the system preview path. Each run builds its own content (a
// stimulus naming the run), so the lower stage's first read is a real miss.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { maskSigned } from "../../../scripts/lang-parity.js";

const [staged, revision] = process.argv.slice(2);
if (!staged || !revision) throw new Error("usage: canary.mjs <stagedBase> <stagedRevision>");
const prod = "https://api.graffiticode.org";
const UA = { "user-agent": "Mozilla/5.0 (Macintosh) Chrome/130 Safari/537.36" };
const run = randomUUID().slice(0, 8);
const programs = JSON.parse(readFileSync(new URL("../../../languages/l0176/crates/core/tests/conformance/programs.json", import.meta.url), "utf8"));
const results = [];
const check = (name, pass, detail = "") => { results.push({ name, pass: Boolean(pass), detail }); console.log(`${pass ? "PASS" : "FAIL"} ${name} ${detail}`); };
const post = async (base, path, body) => {
  const r = await fetch(base + path, { method: "POST", headers: { ...UA, "content-type": "application/json", "x-graffiticode-storage-type": "ephemeral" }, body: JSON.stringify(body) });
  return { status: r.status, headers: r.headers, body: await r.json() };
};
const get = async (base, path) => {
  const r = await fetch(base + path, { headers: UA });
  return { status: r.status, headers: r.headers, body: await r.json() };
};
const task = async t => (await post(prod, "/task", { task: t })).body.data.id;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cc = r => r.headers.get("cache-control");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const generations = suffix => `generations=${encodeURIComponent(suffix)}`;
const formSuffix = async (base, id) => {
  const form = await fetch(`${base}/form?id=${id}`, { headers: UA, redirect: "manual" });
  return new URL(new URL(form.headers.get("location")).searchParams.get("url")).searchParams.get("generations");
};
const envelope = r => r.body?.data; // { data, errors }
const withoutRequest = activity => { const { request: _r, signing: _s, ...rest } = activity ?? {}; return rest; };
// What every signature makes afresh (Broker's): the flat questions packet's.
const fresh = packet => ({ signature: packet?.signature, user_id: packet?.user_id, session_id: packet?.session_id });
const signed = packet => typeof packet?.signature === "string" && typeof packet?.consumer_key === "string" && typeof packet?.session_id === "string";
const SIGNING_WORDS = ["\"request\"", "\"signing\"", "\"session_id\"", "\"signature\"", "\"user_id\"", "\"security\""];
const unsignedText = value => { const text = JSON.stringify(value); return SIGNING_WORDS.every(w => !text.includes(w)); };
const logs = filter => execFileSync("gcloud", ["logging", "read", filter, "--project=graffiticode", "--order=asc", "--limit=500", "--format=json"], { encoding: "utf8" });
const window = (since, until) => [`timestamp>="${new Date(since).toISOString()}"`, `timestamp<="${new Date(until).toISOString()}"`];
// The staged revision's L0176 stage records within [since, until] (it serves only this canary).
const stageRecords = (since, until) => JSON.parse(logs([
  "resource.type=\"cloud_run_revision\"", "resource.labels.service_name=\"api\"", `resource.labels.revision_name="${revision}"`,
  "textPayload:\"stage {\"", ...window(since, until),
].join(" AND "))).map(e => JSON.parse(e.textPayload.slice(e.textPayload.indexOf("{")))).filter(r => r.lang === "0176");
// The staged revision's /preview/sign routing records within [since, until]: which path
// signed (routes/preview.js), from that revision's own log, so production's traffic (its
// commands' `start` calls to /interpret included) can't be counted.
const previewRecords = (since, until) => JSON.parse(logs([
  "resource.type=\"cloud_run_revision\"", "resource.labels.service_name=\"api\"", `resource.labels.revision_name="${revision}"`,
  "textPayload:\"preview-sign {\"", ...window(since, until),
].join(" AND "))).map(e => JSON.parse(e.textPayload.slice(e.textPayload.indexOf("{"))));
const outcome = r => `${r.stage}:${r.run}:${r.mode}:${r.cache}:${r.own?.cacheClass}`;

// The content: an items activity with a stimulus naming this run.
const itemsSrc = "set-var \"lrn-id\" \"t\" items [item [questions [mcq []] {}]] {}..";
const stimulus = `C6 canary ${run}: what is 2 + 2?`;
const withStimulus = ast => {
  // `mcq []` -> `mcq [stimulus "<run>"]`: the mcq's member list gains one attribute.
  const out = JSON.parse(JSON.stringify(ast));
  const keys = Object.keys(out).filter(k => k !== "root").map(Number);
  let next = Math.max(...keys) + 1;
  const mcq = Object.entries(out).find(([, n]) => n?.tag === "MCQ");
  if (!mcq) throw new Error("no mcq in the items program");
  const list = out[mcq[1].elts[0]];
  const str = next++, attr = next++;
  out[str] = { tag: "STR", elts: [stimulus] };
  out[attr] = { tag: "STIMULUS", elts: [str] };
  list.elts = [...list.elts, attr];
  return out;
};
const itemsAst = withStimulus(programs[itemsSrc]);
const dataAst = programs["data {}.."];
// L0000 `data {}..`: a legacy head that answers its input as it is.
const L0000_DATA = { 3: { tag: "RECORD", elts: [] }, 6: { tag: "DATA", elts: [3] }, 10: { tag: "EXPRS", elts: [6] }, 11: { tag: "PROG", elts: [10] }, root: 11 };

const started = Date.now();
const itemId = await task({ lang: "0176", code: itemsAst });

// 1. The URL /form hands out names @L0176=interp-1 (production: commands-1).
const suffix = await formSuffix(staged, itemId);
check("/form data URL names @L0176=interp-1", suffix === "@L0176=interp-1", suffix);
check("production /form still names @L0176=commands-1", (await formSuffix(prod, itemId)) === "@L0176=commands-1");

// 2. A connection-free read: signed, no-store, a fresh signature and Broker session each read,
//    the same activity as production modulo the signature's fresh fields.
const p1 = await get(prod, `/data?id=${itemId}`);
const r1 = await get(staged, `/data?id=${itemId}&${generations(suffix)}`);
const r2 = await get(staged, `/data?id=${itemId}&${generations(suffix)}`);
const [a1, a2, ap] = [r1, r2, p1].map(r => envelope(r)?.data);
check("read: 200, no errors", r1.status === 200 && same(envelope(r1)?.errors, []), JSON.stringify(envelope(r1)?.errors ?? null));
check("read: no-store", cc(r1) === "no-store" && cc(r2) === "no-store", `${cc(r1)} / ${cc(r2)}`);
check("read: signed (local_practice, Broker's session)", signed(a1?.request) && a1.request.type === "local_practice", JSON.stringify(Object.keys(a1?.request ?? {})));
check("read: a fresh signature, user and Broker session each read", ["signature", "user_id", "session_id"].every(k => fresh(a1?.request)[k] !== fresh(a2?.request)[k]), JSON.stringify([fresh(a1?.request), fresh(a2?.request)]));
check("read: the activity carries no session_id; its id is the lrn-id", a1?.data && !("session_id" in a1.data) && a1.data.id === "t", JSON.stringify(a1?.data?.id));
check("read: equals production modulo the signature's fresh fields", same(maskSigned(envelope(r1)), maskSigned(envelope(p1))), JSON.stringify(maskSigned(envelope(r1))).slice(0, 160));
check("production (flag off) unchanged: signed, no-store", signed(ap?.request) && cc(p1) === "no-store", cc(p1));

// 3. MCP's item summary reads the head's data.request.questions.
const summary = q => (q ?? []).map(x => x.stimulus);
check("MCP summary: data.request.questions, as production", (a1?.request?.questions ?? []).length > 0 && same(summary(a1.request.questions), summary(ap?.request?.questions)) && summary(a1.request.questions).includes(stimulus), JSON.stringify(summary(a1?.request?.questions)));

// 4. The lower stage's cache: L0000 `data {}` over the L0176 items. A legacy head answers its
//    input as it is, so what it answers is exactly the L0176 stage's evaluate result, which the
//    second read takes from the stage cache.
const headId = await task({ lang: "0000", code: L0000_DATA });
const lower = `${headId}+${itemId}`;
const lowerSuffix = await formSuffix(staged, lower);
const lowerStart = Date.now();
const l1 = await get(staged, `/data?id=${lower}&${generations(lowerSuffix)}`);
const lowerMid = Date.now();
await sleep(1500);
const l2 = await get(staged, `/data?id=${lower}&${generations(lowerSuffix)}`);
const lowerEnd = Date.now();
const lowerOut = envelope(l1)?.data;
check("lower stage: /form names its generation", lowerSuffix?.includes("@L0176=interp-1"), lowerSuffix);
check("lower stage: no errors, the same both reads", same(envelope(l1)?.errors, []) && same(envelope(l1), envelope(l2)), JSON.stringify(envelope(l1)?.errors ?? null));
check("lower stage: unsigned, no signing or session metadata anywhere", unsignedText(envelope(l1)) && unsignedText(envelope(l2)), JSON.stringify(lowerOut).slice(0, 200));
check("lower stage: the head's activity without its signature", same(lowerOut, withoutRequest(a1)), JSON.stringify(lowerOut).slice(0, 120));
const pl = await get(prod, `/data?id=${lower}`);
check("lower stage: production's (legacy, signed) without its request", same(lowerOut, withoutRequest(envelope(pl)?.data)) && signed(envelope(pl)?.data?.request));

// 5. L0176 over L0176: the head signs afresh each read; the lower stage is the cache's.
const headL = await task({ lang: "0176", code: dataAst });
const pair = `${headL}+${itemId}`;
const pairSuffix = await formSuffix(staged, pair);
const pairStart = Date.now();
const h1 = await get(staged, `/data?id=${pair}&${generations(pairSuffix)}`);
await sleep(1500);
const h2 = await get(staged, `/data?id=${pair}&${generations(pairSuffix)}`);
const pairEnd = Date.now();
const [ha, hb] = [h1, h2].map(r => envelope(r)?.data);
check("L0176 over L0176: /form names @L0176=interp-1", pairSuffix === "@L0176=interp-1", pairSuffix);
check("L0176 over L0176: no errors, no-store", same(envelope(h1)?.errors, []) && cc(h1) === "no-store" && cc(h2) === "no-store", `${cc(h1)} / ${cc(h2)}`);
check("L0176 over L0176: the head is signed, afresh each read", signed(ha?.request) && signed(hb?.request) && ["signature", "user_id", "session_id"].every(k => fresh(ha.request)[k] !== fresh(hb.request)[k]), JSON.stringify([fresh(ha?.request), fresh(hb?.request)]));
check("L0176 over L0176: the head's activity is the lower stage's", same(withoutRequest(ha), lowerOut) && same(withoutRequest(hb), lowerOut));

// 6. /preview/sign: questions and items activities, as production answers them; through
//    /interpret on the staged api (l0176r sees no /interpret from production, whose flag is off).
const questionsActivity = { type: "questions", data: withoutRequest(a1).data };
const itemsActivity = { type: "items", data: withoutRequest(a1).data };
// The whole answer, with only each signature's fresh fields masked (lang-parity's maskSigned:
// the flat questions packet, or the items packet's security and request session).
const maskedAnswer = b => (b?.request ? { ...b, request: maskSigned({ data: b.request }).data } : b);
const signedItems = packet => typeof packet?.security?.signature === "string" && typeof packet?.request?.session_id === "string";
const pq = await post(prod, "/preview/sign", { activity: questionsActivity });
const pi = await post(prod, "/preview/sign", { activity: itemsActivity });
const stagedPreviewStart = Date.now();
const sq = await post(staged, "/preview/sign", { activity: questionsActivity });
const si = await post(staged, "/preview/sign", { activity: itemsActivity });
const stagedPreviewEnd = Date.now();
check("/preview/sign questions: 200, signed, no-store, the whole answer as production's",
  sq.status === 200 && pq.status === 200 && signed(sq.body?.request) && cc(sq) === "no-store" && same(maskedAnswer(sq.body), maskedAnswer(pq.body)),
  `${sq.status}/${pq.status} ${JSON.stringify(maskedAnswer(sq.body)).slice(0, 160)}`);
check("/preview/sign items: 200, signed, no-store, the whole answer as production's",
  si.status === 200 && pi.status === 200 && signedItems(si.body?.request) && signedItems(pi.body?.request) && cc(si) === "no-store" && same(maskedAnswer(si.body), maskedAnswer(pi.body)),
  `${si.status}/${pi.status} ${JSON.stringify(maskedAnswer(si.body)).slice(0, 200)}`);

// Logs arrive with a delay.
await sleep(60_000);
const lowerFirst = stageRecords(lowerStart, lowerMid).map(outcome);
const lowerSecond = stageRecords(lowerMid, lowerEnd).map(outcome);
check("stage cache: the lower stage's first read a miss, stored immutable", same(lowerFirst, ["s1:interpret:evaluate:miss:immutable"]), JSON.stringify(lowerFirst));
check("stage cache: the second read a hit", same(lowerSecond, ["s1:interpret:evaluate:hit:immutable"]), JSON.stringify(lowerSecond));
const pairRecords = stageRecords(pairStart, pairEnd).map(outcome);
check("L0176 over L0176: the lower stage a hit every read; the head presented, no-store, never a hit",
  same(pairRecords, ["s1:interpret:evaluate:hit:immutable", "s0:interpret:present:miss:no-store", "s1:interpret:evaluate:hit:immutable", "s0:interpret:present:miss:no-store"]), JSON.stringify(pairRecords));
const all = stageRecords(started, Date.now());
check("every L0176 stage on the staged api was interpreted", all.length > 0 && all.every(r => r.run === "interpret"), `${all.length} records`);
const routed = previewRecords(stagedPreviewStart, stagedPreviewEnd + 2000);
check("/preview/sign on the staged revision interpreted both, and signed them", same(routed, [
  { run: "interpret", type: "questions", outcome: "signed" }, { run: "interpret", type: "items", outcome: "signed" },
]), JSON.stringify(routed));

const failed = results.filter(r => !r.pass).length;
console.log(JSON.stringify({ ranAt: new Date(started).toISOString(), staged, revision, run, ids: { item: itemId, lower, pair }, stimulus, results, failed }));
process.exitCode = failed ? 1 : 0;
