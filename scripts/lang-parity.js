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
//   - GET /lexicon.json: the same lexicon;
//   - GET /, /form, /lexicon.json and /lexicon.js: the same status, and the
//     same Cache-Control, Content-Type and Cross-Origin-Resource-Policy.
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

export const PROBED_PATHS = ["/", "/form", "/lexicon.json", "/lexicon.js"];
export const COMPARED_HEADERS = ["cache-control", "content-type", "cross-origin-resource-policy"];

// The kinds of reviewed difference a rule can allow:
//   error-text        the same status and envelope except the text of each
//                     error's message (both answers have errors, as many)
//   lexicon-superset  Rust's lexicon has every word TypeScript's has,
//                     unchanged, plus others
//   case              one corpus case, by its program source (`src`)
//   header            one header on one path (`path`, `header`)
// Every rule needs a `note` saying why the difference is acceptable.
export const RULE_KINDS = ["error-text", "lexicon-superset", "case", "header"];

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

// One case: "identical", { allowed: kind }, or "different".
export const compareCase = (ts, rust, { src, rules = [] } = {}) => {
  const a = comparable(ts);
  const b = comparable(rust);
  if (isDeepStrictEqual(a, b)) return "identical";
  if (rules.some(r => r.kind === "case" && r.src === src)) return { allowed: "case" };
  if (rules.some(r => r.kind === "error-text") && a.status === b.status &&
      Array.isArray(a.body?.errors) && Array.isArray(b.body?.errors) && a.body.errors.length > 0 &&
      a.body.errors.length === b.body.errors.length &&
      isDeepStrictEqual(withoutErrorText(a.body), withoutErrorText(b.body))) {
    return { allowed: "error-text" };
  }
  return "different";
};

// The lexicons: "identical", { allowed: "lexicon-superset" }, or "different".
export const compareLexicon = (ts, rust, rules = []) => {
  if (isDeepStrictEqual(ts, rust)) return "identical";
  const isObject = v => v && typeof v === "object" && !Array.isArray(v);
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

// A conformance case with falsy data runs in-process; over HTTP /compile
// refuses it, and the API never sends one.
export const sendable = c => !(c.data !== undefined && !c.data);

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
  if (!/^\d{4}$/.test(lang) || !tsUrl || !rustUrl) {
    console.error("usage: lang-parity.js --lang <NNNN> --ts <TypeScript URL> --rust <Rust URL> [--cases file] [--limit N] [--timeout s] [--out file]");
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
  report.checks.lexicon = { ok: lexicon !== "different", result: lexicon };

  // 2. The corpus, case by case, to both services.
  const cases = JSON.parse(await readFile(casesFile, "utf8")).slice(0, limit);
  const counts = { identical: 0, allowed: {}, different: 0, skipped: 0 };
  const differences = [];
  for (const [i, c] of cases.entries()) {
    if (!sendable(c)) { counts.skipped++; continue; }
    if (Date.now() - mintedAt > 180000) { token = await exchange(); mintedAt = Date.now(); }
    const body = { code: c.ast, data: c.data ?? {} };
    const headers = token ? { Authorization: token } : {};
    const [a, b] = await Promise.all([request(tsUrl, "POST", "/compile", { headers, body }), request(rustUrl, "POST", "/compile", { headers, body })]);
    const result = compareCase(a, b, { src: c.src, rules });
    if (result === "identical") counts.identical++;
    else if (result === "different") {
      counts.different++;
      if (differences.length < 20) differences.push({ case: i, src: c.src, ts: comparable(a), rust: comparable(b) });
    } else counts.allowed[result.allowed] = (counts.allowed[result.allowed] ?? 0) + 1;
  }
  const compared = cases.length - counts.skipped;
  report.checks.corpus = { ok: counts.different === 0 && compared > 0, ...counts, compared, differences };

  report.endedAt = new Date().toISOString();
  report.corpus = corpusBlock({ ranAt, tasks: compared, failures: counts.different + probeDifferences.length + (lexicon === "different" ? 1 : 0) });
  report.passed = Object.values(report.checks).every(c => c.ok);
  const text = JSON.stringify(report, null, 2);
  if (out) await writeFile(out, `${text}\n`);
  console.log(text);
  process.exitCode = report.passed ? 0 : 1;
};

if (import.meta.url === `file://${process.argv[1]}`) await main();
