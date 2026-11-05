// The B5 usage gate's arithmetic (docs/graffiticode-interpreter-plan.md, "Gates for B5 and B6"):
// percentiles, the drive's tallies, the api's stage records read back from Cloud Logging, and
// the gate's verdict. scripts/interpret-soak.js does the driving; everything here is pure.

// The gate's thresholds, as the plan states them.
export const THRESHOLDS = Object.freeze({
  misses: 2000, // fresh interpretations per language
  hits: 2000, // cache hits per language
  corpusRuns: 3, // runs of every corpus case
  perKind: 500, // executions of each model kind a language produces
  perChainShape: 200, // runs of each chain shape
  concurrentShare: 0.2, // share of the drive at a concurrency of 16 or more on one key
  concurrency: 16,
  retryShare: 0.001, // requests that needed a retry after a transient 5xx
  hitRate: 0.95, // repeats served from the stage cache
  latencyFactor: 1.5, // interpreted p95 at most this times the api's legacy-path p95…
  latencySlackMs: 100, // …plus this
});

export const CHAIN_SHAPES = Object.freeze(["interpreted-over-legacy", "legacy-over-interpreted", "interpreted-over-interpreted", "view-loop"]);

// Failure codes that are never expected unless a planted case asks for them.
export const UNEXPECTED_OUTCOMES = Object.freeze(["model-unavailable", "compile-response-lost", "no-store-intermediate"]);

// The p-th percentile (0–100) of a list of numbers, nearest rank; null for none.
export const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
};

const normalizeLang = lang => String(lang).replace(/^L/i, "").padStart(4, "0");

// The drive's own tallies, per language and overall.
export const createTally = langs => {
  const per = {};
  for (const lang of langs.map(normalizeLang)) {
    per[lang] = {
      misses: 0, // fresh inputs sent
      hits: 0, // repeats of an input already answered
      kinds: { value: 0, plan: 0 },
      corpus: { cases: 0, minRuns: 0, runs: {} },
      mismatches: [],
      latency: { miss: [], hit: [], direct: [] },
    };
  }
  return {
    per,
    chains: Object.fromEntries(CHAIN_SHAPES.map(s => [s, 0])),
    chainMismatches: [],
    // The api's legacy path (POST /compile on a compile-only language): the latency baseline.
    legacy: { lang: null, latency: [] },
    requests: 0,
    retried: 0,
    failed: [],
    concurrent: { requests: 0, groups: 0, divergent: [] },
    viewLoop: { immutable: 0, staleNoStore: 0, wrongHeaders: [] },
  };
};

export const recordCorpusRun = (tally, lang, caseIndex) => {
  const c = tally.per[normalizeLang(lang)].corpus;
  c.runs[caseIndex] = (c.runs[caseIndex] ?? 0) + 1;
};

export const finishCorpus = (tally, lang, cases) => {
  const c = tally.per[normalizeLang(lang)].corpus;
  c.cases = cases;
  const counts = Array.from({ length: cases }, (_, i) => c.runs[i] ?? 0);
  c.minRuns = counts.length ? Math.min(...counts) : 0;
  delete c.runs;
};

// A stage record as the api logs it: `stage {...}` (packages/api/src/data.js, logStage).
export const parseStageLine = text => {
  if (typeof text !== "string" || !text.startsWith("stage ")) return null;
  try {
    const record = JSON.parse(text.slice("stage ".length));
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
};

// The interpreted stage records of a window, counted per language: cache hits, misses and
// skips, model kinds, and outcomes.
export const countStageRecords = (records, langs) => {
  const wanted = new Set(langs.map(normalizeLang));
  const per = {};
  for (const r of records) {
    if (!r || r.run !== "interpret") continue;
    const lang = normalizeLang(r.lang);
    if (!wanted.has(lang)) continue;
    const p = (per[lang] ??= { hit: 0, miss: 0, skip: 0, kinds: { value: 0, plan: 0 }, outcomes: {} });
    if (r.cache === "hit" || r.cache === "miss" || r.cache === "skip") p[r.cache]++;
    if (r.kind === "value" || r.kind === "plan") p.kinds[r.kind]++;
    if (r.outcome) p.outcomes[r.outcome] = (p.outcomes[r.outcome] ?? 0) + 1;
  }
  return per;
};

const check = (name, pass, detail) => ({ name, pass: Boolean(pass), detail });

// The gate's verdict over a drive's tally and, when read, its log counts. `kindsByLang` names
// the model kinds each language's corpus produces (each is held to those); `inputReaders` the
// languages that read their input (C2), of which at least one must be in the drive. Returns
// { passed, checks }.
export const evaluateGate = ({ tally, logCounts = null, kindsByLang = {}, inputReaders = [], thresholds = THRESHOLDS, rehearsal = null }) => {
  const t = thresholds;
  const checks = [];
  const langs = Object.keys(tally.per);
  checks.push(check("an input-reading (C2) language is in the drive", langs.some(l => inputReaders.map(normalizeLang).includes(l)), langs.join(", ")));
  for (const lang of langs) {
    const p = tally.per[lang];
    const L = `L${lang}`;
    checks.push(check(`${L}: ${t.misses} fresh interpretations`, p.misses >= t.misses, p.misses));
    checks.push(check(`${L}: ${t.hits} repeats (cache hits)`, p.hits >= t.hits, p.hits));
    checks.push(check(`${L}: every corpus case run ${t.corpusRuns} times`, p.corpus.cases > 0 && p.corpus.minRuns >= t.corpusRuns, `${p.corpus.cases} cases, min ${p.corpus.minRuns}`));
    const kinds = kindsByLang[lang] ?? ["plan"];
    for (const kind of kinds) checks.push(check(`${L}: ${t.perKind} ${kind} executions`, p.kinds[kind] >= t.perKind, p.kinds[kind]));
    checks.push(check(`${L}: every answer equals its oracle`, p.mismatches.length === 0, p.mismatches.slice(0, 3)));
    // Against the api's legacy path, measured in the same drive (plan, criterion 8). The direct
    // compile's p95 is reported, not budgeted: it pays none of the api's route overhead.
    const missP95 = percentile(p.latency.miss, 95);
    const hitP95 = percentile(p.latency.hit, 95);
    const directP95 = percentile(p.latency.direct, 95);
    const legacyP95 = percentile(tally.legacy.latency, 95);
    const budget = legacyP95 === null ? null : legacyP95 * t.latencyFactor + t.latencySlackMs;
    checks.push(check(`${L}: miss p95 within budget`, budget !== null && missP95 !== null && missP95 <= budget, { missP95, legacyP95, budget, directP95 }));
    checks.push(check(`${L}: hit p95 within budget`, budget !== null && hitP95 !== null && hitP95 <= budget, { hitP95, legacyP95, budget, directP95 }));
    if (logCounts) {
      const l = logCounts[lang] ?? { hit: 0, miss: 0, kinds: { value: 0, plan: 0 }, outcomes: {} };
      checks.push(check(`${L}: logs agree (misses)`, l.miss >= p.misses, { logged: l.miss, driven: p.misses }));
      // The drive's repeats are requests it already sent once; at least hitRate of them must be
      // served from the stage cache. (Other traffic in the window only adds hits.)
      checks.push(check(`${L}: repeats hit ${t.hitRate * 100}%`, p.hits > 0 && l.hit >= t.hitRate * p.hits, { logged: l.hit, repeats: p.hits }));
      for (const kind of kinds) checks.push(check(`${L}: logs agree (${kind})`, l.kinds[kind] >= p.kinds[kind], { logged: l.kinds[kind], driven: p.kinds[kind] }));
      const unexpected = UNEXPECTED_OUTCOMES.filter(o => l.outcomes[o]);
      checks.push(check(`${L}: no unexpected failure outcomes`, unexpected.length === 0, unexpected.map(o => `${o}: ${l.outcomes[o]}`)));
    }
  }
  for (const shape of CHAIN_SHAPES) checks.push(check(`chain ${shape}: ${t.perChainShape} runs`, tally.chains[shape] >= t.perChainShape, tally.chains[shape]));
  checks.push(check("chains equal their oracles", tally.chainMismatches.length === 0, tally.chainMismatches.slice(0, 3)));
  checks.push(check("view loop: URLs naming the current generations are immutable, stale ones no-store", tally.viewLoop.wrongHeaders.length === 0 && tally.viewLoop.immutable > 0 && tally.viewLoop.staleNoStore > 0, tally.viewLoop));
  const share = tally.requests ? tally.concurrent.requests / tally.requests : 0;
  checks.push(check(`${t.concurrentShare * 100}% of the drive at concurrency ${t.concurrency}+ on one key`, share >= t.concurrentShare, Number(share.toFixed(3))));
  checks.push(check("concurrent answers for one key are identical", tally.concurrent.divergent.length === 0, tally.concurrent.divergent.slice(0, 3)));
  const retryShare = tally.requests ? tally.retried / tally.requests : 0;
  checks.push(check(`transient retries at most ${t.retryShare * 100}%`, retryShare <= t.retryShare, { retried: tally.retried, requests: tally.requests }));
  checks.push(check("no request failed after its retry", tally.failed.length === 0, tally.failed.slice(0, 3)));
  checks.push(check("rollback rehearsal (criterion 9, run with the owner)", rehearsal?.passed === true, rehearsal ?? "not run in this drive"));
  return { passed: checks.every(c => c.pass), checks };
};
