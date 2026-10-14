#!/usr/bin/env node
/* eslint camelcase: "off" -- Learnosity's request fields are snake_case. */
// AT-11, the credentials probe and the D1 gate (ISOLATE-01; plan:
// ~/.claude/plans/isolate-01-compiler-egress.md, D1). L0158 may keep a Learnosity consumer
// only if Learnosity itself restricts that consumer to preview. `state: preview` is a request
// setting, so it isn't the restriction; this checks the consumer, adversarially.
//
//   node scripts/at11/d1.js server  --consumer <key> --secret-file <file> --domain <domain> [--legacy-consumer <key> --legacy-secret-file <file>] [--out dir]
//   node scripts/at11/d1.js browser --consumer <key> --secret-file <file> --domain <domain> --harness <out.html>
//   node scripts/at11/d1.js judge-browser <results.json> [--out dir]
//
// `server` runs the Data API cases straight against Learnosity: each must be refused. With the
// legacy (rotated) credentials it checks those no longer work either. `browser` writes a page
// that initializes each signed client-side request (Items, Questions, Author, Reports) in a
// real browser and records what Learnosity did; a headless Chrome loads it from the consumer's
// domain and saves window.at11Results, which `judge-browser` checks. A preview init with the
// same consumer is the positive control, in both modes.
//
// Consumer and secret have no defaults and are never written to evidence. Nothing here is run
// until rollout step 6 (deployment deferred).

import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import LearnositySDK from "learnosity-sdk-nodejs";
import { writeEvidence, parseArgs } from "./lib.js";

const DATA_API = "https://data.learnosity.com/v2025.2.LTS";

// Server-side: the Data API, which a preview-only consumer must never be able to use.
export const SERVER_CASES = [
  { id: "data-read-items", route: "/itembank/items", action: "get", request: { limit: 1 } },
  { id: "data-read-questions", route: "/itembank/questions", action: "get", request: { limit: 1 } },
  { id: "data-read-responses", route: "/sessions/responses", action: "get", request: { limit: 1 } },
  // A write of nothing: if, wrongly, it's allowed, nothing changes.
  { id: "data-write-items", route: "/itembank/items", action: "set", request: { items: [] } },
];

// Client-side: each signed init a browser runs. Only the preview control may succeed.
export const BROWSER_CASES = [
  { id: "items-preview (control)", service: "items", control: true, request: { rendering_type: "inline", type: "local_practice", state: "preview", session_id: null, activity_id: "at11", name: "at11", items: ["at11"] } },
  { id: "items-initial", service: "items", request: { rendering_type: "inline", type: "submit_practice", state: "initial", activity_id: "at11", name: "at11", items: ["at11"] } },
  { id: "items-resume", service: "items", request: { rendering_type: "inline", type: "submit_practice", state: "resume", activity_id: "at11", name: "at11", items: ["at11"] } },
  { id: "items-review", service: "items", request: { rendering_type: "inline", type: "submit_practice", state: "review", activity_id: "at11", name: "at11", items: ["at11"] } },
  { id: "items-preview-then-submit", service: "items", submit: true, request: { rendering_type: "inline", type: "submit_practice", state: "preview", activity_id: "at11", name: "at11", items: ["at11"] } },
  { id: "questions-initial", service: "questions", request: { type: "submit_practice", state: "initial", questions: [{ response_id: "at11", type: "shorttext", stimulus: "at11" }] } },
  { id: "author", service: "author", request: { mode: "item_list", config: {} } },
  { id: "reports", service: "reports", request: { reports: [{ id: "at11", type: "sessions-summary", session_ids: ["at11"] }] } },
];

const sign = (sdk, service, { consumer, secret, domain }, request, action) =>
  sdk.init(service, { consumer_key: consumer, domain, user_id: `at11-${randomUUID()}` }, secret, request, action);

// What Learnosity's Data API answer means: refused (a pass), allowed (a failure) or unclear.
export function judgeDataApi(response) {
  if (response.error) return { passed: false, why: `no answer (${response.error}): proves nothing` };
  const meta = response.body?.meta;
  if (meta?.status === true) return { passed: false, why: `ALLOWED: ${response.status}` };
  if (meta?.status === false || (response.status >= 400 && response.status < 500)) return { passed: true, refusal: meta?.message ?? `${response.status}` };
  return { passed: false, why: `unrecognized answer ${response.status}` };
}

export async function runServer(creds, { doFetch = fetch, sdk = new LearnositySDK() } = {}) {
  const rows = [];
  for (const c of SERVER_CASES) {
    const signed = sign(sdk, "data", creds, c.request, c.action);
    let response;
    try {
      const res = await doFetch(`${DATA_API}${c.route}`, { method: "POST", body: new URLSearchParams(signed), signal: AbortSignal.timeout(15000) });
      let body = null;
      try { body = await res.json(); } catch {}
      response = { status: res.status, body: { meta: body?.meta } };
    } catch (e) {
      response = { error: e?.name ?? String(e) };
    }
    rows.push({ id: c.id, response, ...judgeDataApi(response) });
  }
  return rows;
}

// The harness: one iframe-free page that initializes each case with Learnosity's own scripts
// and records readyListener / errorListener, plus, for the submit case, the save attempt.
export function harness(signedCases) {
  const scripts = {
    items: "https://items.learnosity.com/?latest-lts",
    questions: "https://questions.learnosity.com/?latest-lts",
    author: "https://authorapi.learnosity.com/?latest-lts",
    reports: "https://reports.learnosity.com/?latest-lts",
  };
  return `<!doctype html>
<meta charset="utf-8">
<title>AT-11 D1 harness</title>
${Object.values(scripts).map(s => `<script src="${s}"></script>`).join("\n")}
<div id="learnosity_assess"></div><div id="learnosity-author"></div><span class="learnosity-item" data-reference="at11"></span><span class="learnosity-response question-at11"></span>
<script>
const cases = ${JSON.stringify(signedCases)};
window.at11Results = [];
const record = (c, outcome, detail) => window.at11Results.push({ id: c.id, control: !!c.control, outcome, detail: String(detail ?? "") });
const apis = { items: () => window.LearnosityItems, questions: () => window.LearnosityApp, author: () => window.LearnosityAuthor, reports: () => window.LearnosityReports };
for (const c of cases) {
  try {
    const signed = typeof c.signed === "string" ? JSON.parse(c.signed) : c.signed;
    const app = apis[c.service]().init(signed, {
      readyListener() {
        if (!c.submit) return record(c, "initialized");
        try { app.submit({ success: () => record(c, "submitted"), error: e => record(c, "refused", e && e.code) }); } catch (e) { record(c, "refused", e.message); }
      },
      errorListener(e) { record(c, "refused", e && (e.code || e.msg)); },
    });
  } catch (e) { record(c, "refused", e.message); }
}
setTimeout(() => { window.at11Done = true; }, 20000);
</script>
`;
}

export function signedBrowserCases(creds, sdk = new LearnositySDK()) {
  return BROWSER_CASES.map(c => ({ id: c.id, service: c.service, control: !!c.control, submit: !!c.submit, signed: sign(sdk, c.service, creds, c.request) }));
}

// Each case but the control must be refused (or never initialize); the control must initialize.
export function judgeBrowser(results) {
  const rows = BROWSER_CASES.map(c => {
    const r = results.find(x => x.id === c.id);
    if (!r) return { id: c.id, passed: false, why: "no result recorded" };
    if (c.control) return { id: c.id, control: true, passed: r.outcome === "initialized", ...(r.outcome === "initialized" ? {} : { why: `the control was ${r.outcome}` }) };
    const allowed = r.outcome === "initialized" || r.outcome === "submitted";
    return { id: c.id, passed: !allowed, ...(allowed ? { why: `ALLOWED: ${r.outcome}` } : { refusal: r.detail }) };
  });
  const control = rows.find(r => r.control);
  return { void: !control?.passed, passed: !!control?.passed && rows.every(r => r.passed), rows };
}

async function creds(args, prefix = "") {
  const consumer = args[`--${prefix}consumer`];
  const secretFile = args[`--${prefix}secret-file`];
  if (!consumer || !secretFile || !args["--domain"]) throw new Error(`--${prefix}consumer, --${prefix}secret-file and --domain are required`);
  return { consumer, secret: (await readFile(secretFile, "utf8")).trim(), domain: args["--domain"] };
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest, ["--consumer", "--secret-file", "--domain", "--legacy-consumer", "--legacy-secret-file", "--harness", "--out"]);
  if (mode === "server") {
    const rows = (await runServer(await creds(args))).map(r => ({ ...r, credentials: "l0158" }));
    if (args["--legacy-consumer"]) rows.push(...(await runServer(await creds(args, "legacy-"))).map(r => ({ ...r, credentials: "legacy (rotated)" })));
    const result = { probe: "d1-server", at: new Date().toISOString(), passed: rows.every(r => r.passed), rows };
    const file = await writeEvidence(args["--out"], "l0158", "d1-server", result);
    for (const r of rows) console.log(`${r.passed ? "refused" : "FAIL   "} ${r.credentials} ${r.id}${r.why ? ` — ${r.why}` : ""}`);
    console.log(`${result.passed ? "PASSED" : "FAILED"}; evidence: ${file}`);
    process.exit(result.passed ? 0 : 1);
  } else if (mode === "browser") {
    if (!args["--harness"]) throw new Error("--harness <out.html> is required");
    await writeFile(args["--harness"], harness(signedBrowserCases(await creds(args))), { mode: 0o600 });
    console.log(`wrote ${args["--harness"]}: serve it from the consumer's domain, load it in headless Chrome, save window.at11Results after window.at11Done, then: d1.js judge-browser <results.json>`);
  } else if (mode === "judge-browser") {
    const result = { probe: "d1-browser", at: new Date().toISOString(), ...judgeBrowser(JSON.parse(await readFile(args._[0], "utf8"))) };
    const file = await writeEvidence(args["--out"], "l0158", "d1-browser", result);
    for (const r of result.rows) console.log(`${r.passed ? "ok  " : "FAIL"} ${r.id}${r.why ? ` — ${r.why}` : ""}`);
    console.log(`${result.void ? "VOID (the control failed)" : result.passed ? "PASSED" : "FAILED"}; evidence: ${file}`);
    process.exit(result.passed ? 0 : 1);
  } else {
    throw new Error("usage: d1.js server|browser|judge-browser ...");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
