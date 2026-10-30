#!/usr/bin/env node
// P3 (docs/graffiticode-interpreter-plan.md): the live parity gate for a
// language's switch from its TypeScript service to its Rust one (Track A).
// It sends both services the same requests and compares their answers with
// each other, not with a fixture:
//
//   - POST /compile for every case of the language's conformance corpus
//     (languages/lNNNN/crates/core/tests/conformance/cases.json), as the verify
//     account: status and the whole envelope (data, errors, cache, effects),
//     apart from `revision`, which names the deployment;
//   - and again, for every case with upstream data, with that data as the API
//     delivers it to a stage: wrapped in the {data, errors} envelope of the
//     stage below it (a POST /compile's data task, a chain). Raw data alone
//     missed a difference every L0174 recompile showed (2026-10-30);
//   - GET /lexicon.json: the same lexicon, a JSON object on both;
//   - GET /form: each side's HTML loads a script, and every asset it references
//     loads from that side's own server; the two HTML documents are the same;
//   - GET /, /form and /lexicon.json: 200 on both, and the same
//     Cache-Control, Content-Type and Cross-Origin-Resource-Policy.
//
// Every compile answer must arrive with HTTP 200 as a JSON object with an
// `errors` list before it is compared; an answer that doesn't is a failure,
// whatever the other side said, and no rule applies to it.
//
// A difference the language's CLAUDE.md documents and that was reviewed is
// allowed by a rule in scripts/lang-parity.allow.json; every other difference
// fails the gate. Regenerate the corpus from the current TypeScript first
// (each language's `npm run rust:fixtures`): a stale corpus misses programs
// the TypeScript accepts now.
//
//   node scripts/lang-parity.js --lang 0184 --ts <TypeScript URL> --rust <Rust URL> \
//     [--cases <cases.json>] [--limit N] [--timeout seconds] [--out report.json]
//
// --interpreted (interpreter plan C1) checks one Rust service against itself
// instead, before its language's interpreter is turned on in the API: for
// every case, the compile answer must equal what the API's interpreted stage
// would get, POST /compile with "form": "model" then POST /interpret of that
// model against the case's data, in both modes, apart from `revision`. No rule
// applies: interpretation must not change a single answer. A program that
// doesn't compile has no model, and its errors must be the compile's.
//
//   node scripts/lang-parity.js --lang 0184 --interpreted --rust <Rust URL> [--limit N] [--out file]
//
// With the operator's gcloud credentials (the verify account's key is read
// from Secret Manager). Prints one JSON report; its `corpus` block has the
// shape a promote evidence file's `corpus` takes ({ ranAt, tasks, failures }),
// with failures the count of differences no rule allows. Exits 0 only when
// that count is 0 and every check passed.

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

export const PROBED_PATHS = ["/", "/form", "/lexicon.json"];
export const COMPARED_HEADERS = ["cache-control", "content-type", "cross-origin-resource-policy"];

// The kinds of reviewed difference a rule can allow:
//   error-text        the same status and envelope except the text of each
//                     error's message (both answers have errors, as many)
//   error-presentation  the same status and every field but `errors` identical,
//                     both with at least one error: only how the errors are
//                     presented differs (positions, wording, how often one is
//                     reported)
//   lexicon-superset  Rust's lexicon has every word TypeScript's has,
//                     unchanged, plus others
//   upstream-envelope a case whose upstream data is a {data, errors} envelope
//                     (an object whose `errors` is an array): the Rust kernel
//                     unwraps it for every dialect, while a TypeScript
//                     language that reads its input directly spreads the
//                     envelope itself
//   form-body         the two servers' form HTML differs (each must still load
//                     its own script and assets)
//   case              one corpus case, by its program source (`src`)
//   header            one header on one path (`path`, `header`)
// Every rule needs a `note` saying why the difference is acceptable.
export const RULE_KINDS = ["error-text", "error-presentation", "lexicon-superset", "upstream-envelope", "form-body", "case", "header"];

export const ruleProblems = rules => {
  const problems = [];
  for (const [lang, list] of Object.entries(rules ?? {})) {
    if (!/^\d{4}$/.test(lang)) problems.push(`${lang}: not a four-digit language id`);
    if (!Array.isArray(list)) { problems.push(`${lang}: rules must be a list`); continue; }
    for (const [i, r] of list.entries()) {
      const at = `${lang}[${i}]`;
      if (!RULE_KINDS.includes(r?.kind)) problems.push(`${at}: kind must be one of ${RULE_KINDS.join(", ")}`);
      if (typeof r?.note !== "string" || !r.note.trim()) problems.push(`${at}: a note must explain the difference`);
      if (r?.kind === "case" && typeof r.src !== "string") problems.push(`${at}: a case rule names its program source (src)`);
      if (r?.kind === "header" && (typeof r.path !== "string" || typeof r.header !== "string")) problems.push(`${at}: a header rule names its path and header`);
    }
  }
  return problems;
};

const parse = text => { try { return JSON.parse(text); } catch { return undefined; } };

// What is compared of a compile answer: its status and its body, without the
// deployment's `revision`.
export const comparable = ({ status, text }) => {
  const body = parse(text);
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const { revision: _revision, ...rest } = body;
    return { status, body: rest };
  }
  return { status, body: body === undefined ? { text } : body };
};

const withoutErrorText = body => {
  if (!body || typeof body !== "object" || !Array.isArray(body.errors)) return body;
  return { ...body, errors: body.errors.map(e => (e && typeof e === "object" ? { ...e, message: "" } : "")) };
};

const failedWithErrors = body => Boolean(body) && typeof body === "object" && Array.isArray(body.errors) && body.errors.length > 0;
const withoutErrors = ({ errors: _errors, ...rest }) => rest;

// Upstream data in the envelope a chained stage passes on.
export const isEnvelope = data => Boolean(data) && typeof data === "object" && !Array.isArray(data) && Array.isArray(data.errors);

// Why a compile answer can't be compared at all, or null: it must have
// arrived (no transport failure), with HTTP 200, as a JSON object whose
// `errors` is a list. A gate never treats two failures as agreement.
export const answerProblem = ({ status, text }) => {
  if (status === 0) return `no answer (${String(text).slice(0, 80)})`;
  if (status !== 200) return `HTTP ${status}`;
  const body = parse(text);
  if (!body || typeof body !== "object" || Array.isArray(body)) return "not a JSON object";
  if (!Array.isArray(body.errors)) return "no errors list";
  return null;
};

// One case: "identical", { allowed: kind }, "different", or { invalid } when
// either answer can't be compared (answerProblem). `data` is the case's
// upstream data. No rule applies to an invalid answer.
export const compareCase = (ts, rust, { src, data, rules = [] } = {}) => {
  const tsProblem = answerProblem(ts);
  const rustProblem = answerProblem(rust);
  if (tsProblem || rustProblem) return { invalid: { ts: tsProblem, rust: rustProblem } };
  const a = comparable(ts);
  const b = comparable(rust);
  if (isDeepStrictEqual(a, b)) return "identical";
  if (rules.some(r => r.kind === "case" && r.src === src)) return { allowed: "case" };
  if (rules.some(r => r.kind === "upstream-envelope") && isEnvelope(data)) return { allowed: "upstream-envelope" };
  if (rules.some(r => r.kind === "error-presentation") && a.status === b.status && failedWithErrors(a.body) && failedWithErrors(b.body) &&
      isDeepStrictEqual(withoutErrors(a.body), withoutErrors(b.body))) {
    return { allowed: "error-presentation" };
  }
  if (rules.some(r => r.kind === "error-text") && a.status === b.status &&
      Array.isArray(a.body?.errors) && Array.isArray(b.body?.errors) && a.body.errors.length > 0 &&
      a.body.errors.length === b.body.errors.length &&
      isDeepStrictEqual(withoutErrorText(a.body), withoutErrorText(b.body))) {
    return { allowed: "error-text" };
  }
  return "different";
};

// One case under --interpreted: "identical", "different", or { invalid }.
// `compiled` is the /compile answer, `modelled` the model-form answer, and
// `interpreted` the /interpret answers ({ evaluate, present }), or null when
// there was no model to interpret.
export const compareInterpreted = (compiled, modelled, interpreted) => {
  const problems = { compiled: answerProblem(compiled), model: answerProblem(modelled) };
  if (problems.compiled || problems.model) return { invalid: problems };
  const compile = comparable(compiled);
  const model = comparable(modelled).body;
  if (!model.model) {
    // No model: the program doesn't compile, and fails exactly as it compiles.
    const failed = compile.body.data === null && failedWithErrors(model) && isDeepStrictEqual(compile.body.errors, model.errors) &&
      Object.keys(compile.body).every(k => k === "data" || k === "errors");
    return failed ? "identical" : "different";
  }
  for (const [mode, answer] of Object.entries(interpreted ?? {})) {
    const problem = answerProblem(answer);
    if (problem) return { invalid: { [mode]: problem } };
    if (!isDeepStrictEqual(comparable(answer), compile)) return "different";
  }
  return interpreted && Object.keys(interpreted).length ? "identical" : "different";
};

// The lexicons: "identical", { allowed: "lexicon-superset" }, or "different".
// Each must be a JSON object: two missing lexicons are not the same lexicon.
export const compareLexicon = (ts, rust, rules = []) => {
  const isObject = v => v && typeof v === "object" && !Array.isArray(v);
  if (!isObject(ts) || !isObject(rust)) return "different";
  if (isDeepStrictEqual(ts, rust)) return "identical";
  if (rules.some(r => r.kind === "lexicon-superset") && isObject(ts) && isObject(rust) &&
      Object.entries(ts).every(([word, entry]) => isDeepStrictEqual(rust[word], entry))) {
    return { allowed: "lexicon-superset" };
  }
  return "different";
};

// One probed path: its status and compared headers. Returns the differences
// no rule allows.
export const compareProbe = (pathname, ts, rust, rules = []) => {
  const differences = [];
  // A probed path must answer, on both: two failures are not parity.
  for (const [side, r] of [["ts", ts], ["rust", rust]]) {
    if (r.status !== 200) differences.push({ path: pathname, what: "not 200", [side]: r.status });
  }
  if (ts.status !== rust.status) differences.push({ path: pathname, what: "status", ts: ts.status, rust: rust.status });
  for (const header of COMPARED_HEADERS) {
    const a = ts.headers[header] ?? null;
    const b = rust.headers[header] ?? null;
    if (a === b) continue;
    if (rules.some(r => r.kind === "header" && r.path === pathname && r.header.toLowerCase() === header)) continue;
    differences.push({ path: pathname, what: header, ts: a, rust: b });
  }
  return differences;
};

// The assets a form's HTML loads from its own server: every src or href that
// is a relative path (the bundle's hashed /assets/ files, a stylesheet), not
// an absolute URL, a data URL or a fragment.
export const formAssets = html => {
  const refs = new Set();
  for (const m of String(html ?? "").matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const ref = m[1].trim();
    if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) continue;
    refs.add(ref.startsWith("/") ? ref : `/${ref.replace(/^\.\//, "")}`);
  }
  return [...refs].sort();
};

// Problems with one side's form: its HTML must load at least one script, and
// every asset it references must load from the same server, non-empty.
// `fetched` maps each referenced path to { status, length }.
export const formProblems = (side, html, fetched) => {
  const problems = [];
  const assets = formAssets(html);
  if (!assets.some(a => /\.m?js(?:\?|$)/.test(a))) problems.push({ side, what: "the form loads no script" });
  for (const a of assets) {
    const r = fetched[a];
    if (!r || r.status !== 200 || !(r.length > 0)) problems.push({ side, what: `asset ${a}`, status: r?.status ?? null, length: r?.length ?? 0 });
  }
  return problems;
};

// A conformance case with falsy data runs in-process; over HTTP /compile
// refuses it, and the API never sends one.
export const sendable = c => !(c.data !== undefined && !c.data);

// A case's upstream data as the API delivers it to a stage: the envelope the
// stage below it answered. Only data a stage would receive: a case without
// any (or with an empty record, which POST /compile never appends) has none.
export const asDelivered = data => {
  if (data === undefined || data === null) return null;
  if (typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 0) return null;
  return { data, errors: [] };
};

// The report's corpus block, in the promote evidence's shape.
export const corpusBlock = ({ ranAt, tasks, failures }) => ({ ranAt, tasks, failures });

const main = async () => {
  const args = process.argv.slice(2);
  const arg = (name, fallback = undefined) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
  const lang = String(arg("--lang", "")).replace(/^L/i, "").padStart(4, "0");
  const tsUrl = arg("--ts");
  const rustUrl = arg("--rust");
  const casesFile = arg("--cases", path.join(ROOT, `languages/l${lang}/crates/core/tests/conformance/cases.json`));
  const limit = Number(arg("--limit", "0")) || Infinity;
  const timeoutMs = Number(arg("--timeout", "60")) * 1000;
  const out = arg("--out");
  const interpretedMode = args.includes("--interpreted");
  if (!/^\d{4}$/.test(lang) || !rustUrl || (!tsUrl && !interpretedMode)) {
    console.error("usage: lang-parity.js --lang <NNNN> (--ts <TypeScript URL> | --interpreted) --rust <Rust URL> [--cases file] [--limit N] [--timeout s] [--out file]");
    process.exit(2);
  }

  const allRules = JSON.parse(await readFile(path.join(ROOT, "scripts/lang-parity.allow.json"), "utf8"));
  const problems = ruleProblems(allRules);
  if (problems.length) { console.error(problems.join("\n")); process.exit(2); }
  const rules = allRules[lang] ?? [];

  const request = async (base, method, pathname, { headers = {}, body } = {}) => {
    try {
      const res = await fetch(new URL(pathname, base), {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, headers: Object.fromEntries(res.headers), text: await res.text() };
    } catch (e) {
      return { status: 0, headers: {}, text: `${e.name}: ${e.message}` };
    }
  };

  // The verify account's token; it lasts about 5 minutes, so a long corpus
  // exchanges a fresh one every 3.
  const key = execFileSync("gcloud", ["secrets", "versions", "access", "latest", "--secret=verify-api-key", "--project=graffiticode"], { encoding: "utf8" }).trim();
  const exchange = async () => {
    const res = await fetch("https://auth.graffiticode.org/authenticate/api-key", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: key }) });
    return (await res.json())?.data?.accessToken;
  };
  let token = await exchange();
  let mintedAt = Date.now();

  const ranAt = new Date().toISOString();
  if (interpretedMode) {
    const cases = JSON.parse(await readFile(casesFile, "utf8")).slice(0, limit);
    const counts = { identical: 0, different: 0, invalid: 0, skipped: 0, values: 0, plans: 0 };
    const differences = [];
    const invalid = [];
    for (const [i, c] of cases.entries()) {
      if (!sendable(c)) { counts.skipped++; continue; }
      if (Date.now() - mintedAt > 180000) { token = await exchange(); mintedAt = Date.now(); }
      const headers = token ? { Authorization: token } : {};
      const data = c.data ?? {};
      const [compiled, modelled] = await Promise.all([
        request(rustUrl, "POST", "/compile", { headers, body: { code: c.ast, data } }),
        request(rustUrl, "POST", "/compile", { headers, body: { code: c.ast, data: {}, form: "model" } }),
      ]);
      const model = parse(modelled.text)?.model;
      let interpreted = null;
      if (model) {
        if (model.kind === "value") counts.values++;
        else counts.plans++;
        const [evaluate, present] = await Promise.all(["evaluate", "present"].map(mode =>
          request(rustUrl, "POST", "/interpret", { headers, body: { model, input: data, mode } })));
        interpreted = { evaluate, present };
      }
      const result = compareInterpreted(compiled, modelled, interpreted);
      if (result === "identical") counts.identical++;
      else if (result === "different") {
        counts.different++;
        if (differences.length < 20) {
          differences.push({ case: i, src: c.src, compiled: comparable(compiled), model: comparable(modelled), interpreted: interpreted && Object.fromEntries(Object.entries(interpreted).map(([m, a]) => [m, comparable(a)])) });
        }
      } else {
        counts.invalid++;
        if (invalid.length < 20) invalid.push({ case: i, src: c.src, ...result.invalid });
      }
    }
    const compared = cases.length - counts.skipped;
    const report = { lang, mode: "interpreted", rust: rustUrl, ranAt, cases: casesFile, endedAt: new Date().toISOString() };
    report.checks = { interpreted: { ok: counts.different === 0 && counts.invalid === 0 && compared > 0, ...counts, compared, differences, invalidAnswers: invalid } };
    report.corpus = corpusBlock({ ranAt, tasks: compared, failures: counts.different + counts.invalid });
    report.passed = report.checks.interpreted.ok;
    const text = JSON.stringify(report, null, 2);
    if (out) await writeFile(out, `${text}\n`);
    console.log(text);
    process.exitCode = report.passed ? 0 : 1;
    return;
  }
  const report = { lang, ts: tsUrl, rust: rustUrl, ranAt, cases: casesFile, checks: {} };

  // 1. The probed paths, and the lexicon itself.
  const probeDifferences = [];
  let lexicon = "different";
  for (const p of PROBED_PATHS) {
    const [a, b] = await Promise.all([request(tsUrl, "GET", p), request(rustUrl, "GET", p)]);
    probeDifferences.push(...compareProbe(p, a, b, rules));
    if (p === "/lexicon.json") lexicon = compareLexicon(parse(a.text), parse(b.text), rules);
  }
  report.checks.probes = { ok: probeDifferences.length === 0, differences: probeDifferences };

  // The served form: each side's HTML, and every asset it loads, from that
  // side's own server. The two HTML documents are compared too: a form that
  // differs needs a reviewed `form-body` rule.
  const formIssues = [];
  const forms = {};
  for (const [side, base] of [["ts", tsUrl], ["rust", rustUrl]]) {
    const form = await request(base, "GET", "/form");
    forms[side] = form.text;
    const fetched = {};
    for (const a of formAssets(form.text)) {
      const r = await request(base, "GET", a);
      fetched[a] = { status: r.status, length: r.text.length };
    }
    formIssues.push(...formProblems(side, form.text, fetched));
  }
  if (forms.ts !== forms.rust && !rules.some(r => r.kind === "form-body")) formIssues.push({ what: "the two forms' HTML differs", ts: formAssets(forms.ts), rust: formAssets(forms.rust) });
  report.checks.form = { ok: formIssues.length === 0, problems: formIssues };
  report.checks.lexicon = { ok: lexicon !== "different", result: lexicon };

  // 2. The corpus, case by case, to both services.
  const cases = JSON.parse(await readFile(casesFile, "utf8")).slice(0, limit);
  const tally = () => ({ counts: { identical: 0, allowed: {}, different: 0, invalid: 0, skipped: 0 }, differences: [], invalid: [] });
  const raw = tally();
  const delivered = tally();
  const record = (into, i, c, data, a, b) => {
    const result = compareCase(a, b, { src: c.src, data, rules });
    if (result === "identical") into.counts.identical++;
    else if (result === "different") {
      into.counts.different++;
      if (into.differences.length < 20) into.differences.push({ case: i, src: c.src, data, ts: comparable(a), rust: comparable(b) });
    } else if (result.invalid) {
      into.counts.invalid++;
      if (into.invalid.length < 20) into.invalid.push({ case: i, src: c.src, ...result.invalid });
    } else into.counts.allowed[result.allowed] = (into.counts.allowed[result.allowed] ?? 0) + 1;
  };
  for (const [i, c] of cases.entries()) {
    if (!sendable(c)) { raw.counts.skipped++; continue; }
    if (Date.now() - mintedAt > 180000) { token = await exchange(); mintedAt = Date.now(); }
    const headers = token ? { Authorization: token } : {};
    const send = data => Promise.all([tsUrl, rustUrl].map(base => request(base, "POST", "/compile", { headers, body: { code: c.ast, data } })));
    const [a, b] = await send(c.data ?? {});
    record(raw, i, c, c.data, a, b);
    const envelope = asDelivered(c.data);
    if (envelope) {
      const [ea, eb] = await send(envelope);
      record(delivered, i, c, envelope, ea, eb);
    }
  }
  const counts = raw.counts;
  const compared = cases.length - counts.skipped;
  report.checks.corpus = { ok: counts.different === 0 && counts.invalid === 0 && compared > 0, ...counts, compared, differences: raw.differences, invalidAnswers: raw.invalid };
  const enveloped = Object.values(delivered.counts).reduce((n, v) => n + (typeof v === "number" ? v : Object.values(v).reduce((a, b) => a + b, 0)), 0);
  report.checks.envelopes = { ok: delivered.counts.different === 0 && delivered.counts.invalid === 0, ...delivered.counts, compared: enveloped, differences: delivered.differences, invalidAnswers: delivered.invalid };

  report.endedAt = new Date().toISOString();
  report.corpus = corpusBlock({ ranAt, tasks: compared + enveloped, failures: counts.different + counts.invalid + delivered.counts.different + delivered.counts.invalid + formIssues.length + probeDifferences.length + (lexicon === "different" ? 1 : 0) });
  report.passed = Object.values(report.checks).every(c => c.ok);
  const text = JSON.stringify(report, null, 2);
  if (out) await writeFile(out, `${text}\n`);
  console.log(text);
  process.exitCode = report.passed ? 0 : 1;
};

if (import.meta.url === `file://${process.argv[1]}`) await main();
