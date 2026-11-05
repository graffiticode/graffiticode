// The B5 usage gate's synthetic drive (docs/graffiticode-interpreter-plan.md, "Gates for B5 and
// B6"). It drives production's interpreted read path as the eval account, checks every answer
// against an oracle, reads the api's stage records for the window back from Cloud Logging, and
// writes the gate report.
//
//   set -a; source ../graffiticode-app/.env.local; set +a   # EVAL_API_KEY
//   node scripts/interpret-soak.js --langs 0184,0186,0175,0179,0181 \
//     [--api https://api.graffiticode.org] [--misses 2000] [--hits 2000] [--concurrency 16] \
//     [--out docs/evidence/b5-gate/<date>] [--no-logs] [--rehearsal <file>] [--baseline-lang 0185]
//
// For each language:
//   - corpus: every corpus case that compiles is read through GET /data three times. Its oracle
//     is the language's own service (lNNNN.graffiticode.org) compiling it directly;
//   - misses: POST /compile of a case over fresh form state (the View's loop), so each one is a
//     new stage-cache key. Its oracle is the direct compile over the same state as delivered;
//   - hits: the same requests again, which the stage cache must answer;
//   - concurrency: every fifth miss and hit is sent `--concurrency` times at once, and the
//     answers must be identical;
//   - latency: each request's elapsed time. The budget's baseline is the api's legacy path:
//     after each language's misses, as many POST /compile requests over fresh form state for a
//     compile-only language (--baseline-lang), at the same concurrency. The direct compile's
//     time is reported beside it.
// Then the chain shapes: an interpreted stage over a legacy L0000 stage, L0000 over an
// interpreted one, two interpreted stages, and the View's loop with generation URLs.
// Criterion 9, the rollback rehearsal, needs api releases and is run with the owner; pass its
// record with --rehearsal.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { countStageRecords, createTally, evaluateGate, finishCorpus, parseStageLine, percentile, recordCorpusRun, THRESHOLDS } from "./lib/interpret-soak.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const LANGS = String(flag("--langs", "0184,0186,0175,0179,0181")).split(",").map(s => s.trim().replace(/^L/i, "").padStart(4, "0"));
const API = flag("--api", "https://api.graffiticode.org");
const MISSES = Number(flag("--misses", THRESHOLDS.misses));
const HITS = Number(flag("--hits", THRESHOLDS.hits));
const CONCURRENCY = Number(flag("--concurrency", THRESHOLDS.concurrency));
const OUT = flag("--out", path.join("docs/evidence/b5-gate", new Date().toISOString().slice(0, 10)));
const READ_LOGS = !args.includes("--no-logs");
const REHEARSAL = flag("--rehearsal");
const BASELINE_LANG = String(flag("--baseline-lang", "0185")).replace(/^L/i, "").padStart(4, "0");
const INPUT_READERS = ["0003", "0010", "0014", "0174", "0177", "0178", "0179", "0180", "0181", "0183"];
const ROOT = new URL("..", import.meta.url).pathname;
const RUN = Math.random().toString(36).slice(2, 10);
const UA = { "user-agent": "graffiticode-interpret-soak" };

if (!process.env.EVAL_API_KEY) {
  console.error("EVAL_API_KEY is required (the eval account's key; source graffiticode-app/.env.local)");
  process.exit(2);
}

// The eval account's token, exchanged afresh every 3 minutes (they last about 5).
let token = null;
let mintedAt = 0;
const auth = async () => {
  if (token && Date.now() - mintedAt < 180000) return token;
  const res = await fetch("https://auth.graffiticode.org/authenticate/api-key", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: process.env.EVAL_API_KEY }) });
  token = (await res.json())?.data?.accessToken;
  if (!token) throw new Error("the eval key didn't exchange for a token");
  mintedAt = Date.now();
  return token;
};

const tally = createTally(LANGS);

// One request, retried once on a transport failure or a 5xx; counted either way.
const send = async (url, { method = "GET", body, authed = true } = {}) => {
  const headers = { ...UA, ...(body ? { "content-type": "application/json" } : {}), ...(authed ? { authorization: await auth() } : {}) };
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = performance.now();
    try {
      const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
      const text = await res.text();
      const ms = performance.now() - started;
      if (res.status >= 500 && attempt === 0) { tally.retried++; continue; }
      tally.requests++;
      if (res.status >= 500) tally.failed.push({ url, status: res.status });
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, headers: res.headers, json, ms };
    } catch (e) {
      if (attempt === 0) { tally.retried++; continue; }
      tally.requests++;
      tally.failed.push({ url, error: String(e?.message ?? e) });
      return { status: 0, headers: new Headers(), json: null, ms: performance.now() - started };
    }
  }
};

// A compile answer as compared: its data and errors, nothing the deployment adds.
const answer = body => (body && typeof body === "object" ? { data: body.data ?? null, errors: body.errors ?? [] } : null);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// What a mismatch keeps: the reply's status and both answers, cut short.
const evidence = (reply, oracle) => ({ status: reply?.status, got: JSON.stringify(answer(reply?.json?.data))?.slice(0, 300), want: JSON.stringify(oracle)?.slice(0, 300) });
const langUrl = lang => `https://l${lang}.graffiticode.org`;
const direct = async (lang, code, data, form) => send(`${langUrl(lang)}/compile`, { method: "POST", body: { code, data, ...(form ? { form } : {}) }, authed: false });
const asDelivered = data => ({ data, errors: [] });
const postTask = async (lang, code) => (await send(`${API}/task`, { method: "POST", body: { task: { lang, code } } })).json?.data?.id;

// Runs `jobs` (functions) `width` at a time.
const pool = async (jobs, width) => {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
    while (next < jobs.length) await jobs[next++]();
  }));
};

// Sends one request `n` times at once; the answers must be identical. Returns the first.
const burst = async (n, request, label) => {
  const replies = await Promise.all(Array.from({ length: n }, request));
  tally.concurrent.requests += n;
  tally.concurrent.groups++;
  const first = JSON.stringify(answer(replies[0].json?.data));
  if (replies.some(r => JSON.stringify(answer(r.json?.data)) !== first)) tally.concurrent.divergent.push(label);
  return replies[0];
};

const prepare = async lang => {
  const all = JSON.parse(await readFile(path.join(ROOT, `languages/l${lang}/crates/core/tests/conformance/cases.json`), "utf8"));
  const cases = [];
  await pool(all.map((c, i) => async () => {
    const [oracle, model] = await Promise.all([direct(lang, c.ast, {}), direct(lang, c.ast, {}, "model")]);
    if (oracle.status !== 200 || answer(oracle.json)?.errors?.length) return;
    const kind = model.json?.model?.kind === "value" ? "value" : "plan";
    const id = await postTask(lang, c.ast);
    if (id) cases.push({ i, ast: c.ast, id, kind, oracle: answer(oracle.json), directMs: oracle.ms });
  }), 8);
  return cases.sort((a, b) => a.i - b.i);
};

// The legacy-path baseline's task: the first case of a compile-only language that compiles
// and fetches nothing.
let baselineTask = null;
const baseline = async () => {
  if (baselineTask) return baselineTask;
  const all = JSON.parse(await readFile(path.join(ROOT, `languages/l${BASELINE_LANG}/crates/core/tests/conformance/cases.json`), "utf8"));
  // A program that fetches nothing, so the baseline is the api's path and not a remote read.
  for (const c of all.filter(c => !/fetch/i.test(c.src ?? ""))) {
    const r = await direct(BASELINE_LANG, c.ast, {});
    if (r.status === 200 && !answer(r.json)?.errors?.length) {
      baselineTask = await postTask(BASELINE_LANG, c.ast);
      tally.legacy.lang = BASELINE_LANG;
      return baselineTask;
    }
  }
  throw new Error(`no L${BASELINE_LANG} case compiles for the baseline`);
};

// As many legacy-path requests as the misses just sent, at the same concurrency.
const driveBaseline = async (count, tag) => {
  const id = await baseline();
  await pool(Array.from({ length: count }, (_, n) => async () => {
    const r = await send(`${API}/compile`, { method: "POST", body: { id, data: { soak: RUN, baseline: tag, n } } });
    if (r.status === 200) tally.legacy.latency.push(r.ms);
  }), CONCURRENCY);
};

const driveLanguage = async lang => {
  const p = tally.per[lang];
  const cases = await prepare(lang);
  console.error(`L${lang}: ${cases.length} cases compile (${cases.filter(c => c.kind === "value").length} value models)`);
  if (!cases.length) return;

  // Corpus: every case, three times, through GET /data.
  const corpusJobs = [];
  for (let run = 0; run < THRESHOLDS.corpusRuns; run++) {
    for (const c of cases) {
      corpusJobs.push(async () => {
        const r = await send(`${API}/data?id=${c.id}`);
        recordCorpusRun(tally, lang, cases.indexOf(c));
        p.kinds[c.kind]++;
        if (!same(answer(r.json?.data), c.oracle)) p.mismatches.push({ case: c.i, via: "/data", ...evidence(r, c.oracle) });
      });
    }
  }
  await pool(corpusJobs, CONCURRENCY);
  finishCorpus(tally, lang, cases.length);

  // Misses over fresh form state, balanced across the kinds the corpus has; then the same
  // requests again as repeats. Every fifth one goes out as a burst.
  const byKind = { value: cases.filter(c => c.kind === "value"), plan: cases.filter(c => c.kind === "plan") };
  const kinds = Object.keys(byKind).filter(k => byKind[k].length);
  const sent = [];
  const fresh = Array.from({ length: MISSES }, (_, n) => {
    const pick = byKind[kinds[n % kinds.length]];
    return { c: pick[Math.floor(n / kinds.length) % pick.length], data: { soak: RUN, n } };
  });
  // The oracle, a direct compile of the same request; its time is the latency baseline, taken
  // alongside the interpreted request it answers for.
  const oracleFor = async ({ c, data }) => {
    const r = await direct(lang, c.ast, asDelivered(data));
    p.latency.direct.push(r.ms);
    return answer(r.json);
  };
  const compile = ({ c, data }) => () => send(`${API}/compile`, { method: "POST", body: { id: c.id, data } });
  await pool(fresh.map((req, n) => async () => {
    const [reply, oracle] = await Promise.all([
      n % 5 === 0 ? burst(CONCURRENCY, compile(req), `L${lang} miss ${n}`) : compile(req)(),
      oracleFor(req),
    ]);
    p.misses++;
    p.kinds[req.c.kind]++;
    p.latency.miss.push(reply.ms);
    if (!same(answer(reply.json?.data), oracle)) p.mismatches.push({ case: req.c.i, via: "/compile", n, ...evidence(reply, oracle) });
    sent.push({ ...req, oracle });
  }), CONCURRENCY);
  await driveBaseline(MISSES, lang);
  const repeats = Array.from({ length: HITS }, (_, n) => sent[n % sent.length]);
  await pool(repeats.map((req, n) => async () => {
    const reply = n % 5 === 0 ? await burst(CONCURRENCY, compile(req), `L${lang} hit ${n}`) : await compile(req)();
    p.hits++;
    p.kinds[req.c.kind]++;
    p.latency.hit.push(reply.ms);
    if (!same(answer(reply.json?.data), req.oracle)) p.mismatches.push({ case: req.c.i, via: "/compile repeat", n, ...evidence(reply, req.oracle) });
  }), CONCURRENCY);
  return cases;
};

// L0000 tasks for the chains: a record built from n (a tail), and a number (a head that ignores
// its input).
const l0000Record = n => ({ 1: { tag: "STR", elts: ["n"] }, 2: { tag: "NUM", elts: [String(n)] }, 3: { tag: "BINDING", elts: [1, 2] }, 4: { tag: "RECORD", elts: [3] }, 5: { tag: "EXPRS", elts: [4] }, 6: { tag: "PROG", elts: [5] }, root: 6 });
const l0000One = { 1: { tag: "NUM", elts: ["1"] }, 2: { tag: "EXPRS", elts: [1] }, 3: { tag: "PROG", elts: [2] }, root: 3 };

const driveChains = async corpora => {
  const langs = Object.keys(corpora).filter(l => corpora[l]?.length);
  const per = Math.ceil(THRESHOLDS.perChainShape / langs.length);
  const headId = await postTask("0000", l0000One);
  const jobs = [];
  for (const [li, lang] of langs.entries()) {
    const cases = corpora[lang];
    const other = langs[(li + 1) % langs.length];
    for (let n = 0; n < per; n++) {
      const c = cases[n % cases.length];
      // An interpreted stage over a legacy L0000 stage.
      jobs.push(async () => {
        const tail = l0000Record(n);
        const tailId = await postTask("0000", tail);
        const [r, t] = await Promise.all([send(`${API}/data?id=${c.id}+${tailId}`), direct("0000", tail, {})]);
        const oracle = answer((await direct(lang, c.ast, asDelivered(answer(t.json).data))).json);
        tally.chains["interpreted-over-legacy"]++;
        if (!same(answer(r.json?.data), oracle)) tally.chainMismatches.push({ shape: "interpreted-over-legacy", lang, case: c.i, n, ...evidence(r, oracle) });
      });
      // A legacy L0000 stage over an interpreted one.
      jobs.push(async () => {
        const [r, below] = await Promise.all([send(`${API}/data?id=${headId}+${c.id}`), Promise.resolve(c.oracle)]);
        const oracle = answer((await direct("0000", l0000One, asDelivered(below.data))).json);
        tally.chains["legacy-over-interpreted"]++;
        if (!same(answer(r.json?.data), oracle)) tally.chainMismatches.push({ shape: "legacy-over-interpreted", lang, case: c.i, n, ...evidence(r, oracle) });
      });
      // Two interpreted stages.
      if (other !== lang) {
        jobs.push(async () => {
          const d = corpora[other][n % corpora[other].length];
          const r = await send(`${API}/data?id=${c.id}+${d.id}`);
          const oracle = answer((await direct(lang, c.ast, asDelivered(d.oracle.data))).json);
          tally.chains["interpreted-over-interpreted"]++;
          if (!same(answer(r.json?.data), oracle)) tally.chainMismatches.push({ shape: "interpreted-over-interpreted", lang, over: other, case: c.i, n, ...evidence(r, oracle) });
        });
      }
      // The View's loop: a recompile over form state, then its data URL with the current
      // generations (immutable) and with a stale one (no-store).
      jobs.push(async () => {
        const data = { soak: RUN, view: n };
        const r = await send(`${API}/compile`, { method: "POST", body: { id: c.id, data } });
        tally.chains["view-loop"]++;
        const id = r.json?.id;
        if (!id) { tally.chainMismatches.push({ shape: "view-loop", lang, case: c.i, missing: "id" }); return; }
        // The generations the api names for this chain, as /form puts them in the View's data URL.
        // As the View fetches it, with the caller's credentials: an authenticated recompile's data
        // task is the caller's own.
        const form = await fetch(`${API}/form?id=${id}`, { headers: { ...UA, authorization: await auth() }, redirect: "manual" });
        const dataUrl = form.headers.get("location") ? new URL(form.headers.get("location")).searchParams.get("url") : null;
        const generations = dataUrl ? new URL(dataUrl).searchParams.get("generations") : null;
        if (!generations?.includes(`@L${lang}=interp-1`)) { tally.viewLoop.wrongHeaders.push({ lang, generations }); return; }
        const current = await send(`${API}/data?id=${id}&generations=${encodeURIComponent(generations)}`);
        const stale = await send(`${API}/data?id=${id}&generations=${encodeURIComponent(generations.replace(`@L${lang}=interp-1`, `@L${lang}=rust-0`))}`);
        const cc = current.headers.get("cache-control") ?? "";
        const sc = stale.headers.get("cache-control") ?? "";
        if (cc.includes("immutable")) tally.viewLoop.immutable++;
        if (sc === "no-store") tally.viewLoop.staleNoStore++;
        if (!cc.includes("immutable") || sc !== "no-store") tally.viewLoop.wrongHeaders.push({ lang, current: cc, stale: sc });
      });
    }
  }
  await pool(jobs, CONCURRENCY);
};

// The api's stage records for the window, from Cloud Logging.
const readStageRecords = (since, until) => {
  const filter = [
    "resource.type=\"cloud_run_revision\"",
    "resource.labels.service_name=\"api\"",
    "textPayload:\"stage {\"",
    `timestamp>="${since}"`,
    `timestamp<="${until}"`,
  ].join(" AND ");
  const out = execFileSync("gcloud", ["logging", "read", filter, "--project=graffiticode", "--limit=1000000", "--format=value(textPayload)"], { encoding: "utf8", maxBuffer: 1 << 30 });
  return out.split("\n").map(parseStageLine).filter(Boolean);
};

const main = async () => {
  const since = new Date().toISOString();
  console.error(`soak ${RUN}: ${LANGS.map(l => `L${l}`).join(", ")} via ${API}, ${MISSES} misses and ${HITS} hits each, concurrency ${CONCURRENCY}`);
  const corpora = {};
  for (const lang of LANGS) corpora[lang] = await driveLanguage(lang);
  await driveChains(corpora);
  const until = new Date().toISOString();
  // Logs arrive within a minute or two.
  if (READ_LOGS) await new Promise(resolve => setTimeout(resolve, 120000));
  const logCounts = READ_LOGS ? countStageRecords(readStageRecords(since, until), LANGS) : null;
  const rehearsal = REHEARSAL ? JSON.parse(await readFile(REHEARSAL, "utf8")) : null;
  // Each language is held to the model kinds its corpus produces.
  const kindsByLang = Object.fromEntries(LANGS.map(l => [l, ["value", "plan"].filter(k => corpora[l]?.some(c => c.kind === k))]));
  const verdict = evaluateGate({ tally, logCounts, kindsByLang, inputReaders: INPUT_READERS, rehearsal });
  const summary = Object.fromEntries(LANGS.map(l => {
    const p = tally.per[l];
    return [`L${l}`, {
      misses: p.misses,
      hits: p.hits,
      kinds: p.kinds,
      corpus: p.corpus,
      mismatches: p.mismatches.length,
      p95: { miss: percentile(p.latency.miss, 95), hit: percentile(p.latency.hit, 95), direct: percentile(p.latency.direct, 95) },
      logged: logCounts?.[l] ?? null
    }];
  }));
  const legacy = { lang: tally.legacy.lang, requests: tally.legacy.latency.length, p50: percentile(tally.legacy.latency, 50), p95: percentile(tally.legacy.latency, 95) };
  const report = {
    legacy,
    run: RUN,
    api: API,
    since,
    until,
    langs: LANGS,
    thresholds: THRESHOLDS,
    summary,
    chains: tally.chains,
    concurrent: { ...tally.concurrent, share: tally.concurrent.requests / Math.max(1, tally.requests) },
    requests: tally.requests,
    retried: tally.retried,
    failed: tally.failed.slice(0, 20),
    viewLoop: tally.viewLoop,
    passed: verdict.passed,
    checks: verdict.checks
  };
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const c of verdict.checks) console.error(`${c.pass ? "PASS" : "FAIL"} ${c.name}${c.pass ? "" : ` ${JSON.stringify(c.detail)?.slice(0, 160)}`}`);
  console.error(`${verdict.passed ? "gate passed" : "gate FAILED"}; report in ${path.join(OUT, "report.json")}`);
  process.exitCode = verdict.passed ? 0 : 1;
};

main().catch(e => { console.error(e); process.exit(1); });
