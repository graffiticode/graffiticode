// The B6 drive's verdicts (scripts/b6-drive.js), as pure functions over what it
// read, so each can be tested offline before the live drive (the owner's
// review of #390). Nothing here reads a service.

import { randomBytes } from "node:crypto";

// A fresh nonce for every case the drive builds (the owner's review of
// fdab0c26): tasks are content-addressed, so a case's chain is its own only if
// something in it is. It goes into the L0176 head program and into the L0185
// stage's fetch URL as `?case=<nonce>` (the proxy's exact-path exception
// matches the path with the query removed; the object ignores it).
export const caseNonce = () => randomBytes(6).toString("hex");
export const sourceCaseUrl = (url, nonce) => `${url}?case=${encodeURIComponent(nonce)}`;

// The phases whose latest run must have passed before the report can pass.
export const MANDATORY_PHASES = Object.freeze([
  "checks", "originals-fail", "originals-drop", "originals-narrow", "probes", "repairs",
  "exclusion", "reconcile", "dropped", "boundary", "source-change", "retries",
]);

// Every mandatory phase that never ran, or whose latest run didn't pass.
export const phaseProblems = (runs = [], required = MANDATORY_PHASES) => required.flatMap(phase => {
  const latest = runs.filter(r => r.phase === phase).at(-1);
  if (!latest) return [`${phase}: never ran`];
  return latest.ok === true ? [] : [`${phase}: its latest run didn't pass`];
});

// What GET /data answered: an artifact, or not. The api answers
// { status: "success", data: { data, errors } } either way; an artifact is a
// 200 whose envelope has no errors and a result.
export const artifactPresent = res => {
  const envelope = res?.json?.data;
  return res?.status === 200 && res?.json?.status === "success" && Boolean(envelope) && typeof envelope === "object" &&
    Array.isArray(envelope.errors) && envelope.errors.length === 0 && envelope.data !== undefined && envelope.data !== null;
};

// The saved item references anywhere in a value (a save's result is
// { saved: true, references }), and the `lrn-id` each was sent under: Broker
// maps a sent reference `graffiticode-<lrn-id>-<n>` to
// `gc-<16 hex of the operation id>-<sent>` (broker operations.ts).
export const savedReferences = value => {
  const out = new Set();
  const walk = v => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    if (v.saved === true && Array.isArray(v.references)) v.references.filter(r => typeof r === "string").forEach(r => out.add(r));
    Object.values(v).forEach(walk);
  };
  walk(value);
  return [...out];
};
export const lrnIdOf = reference => /^gc-[0-9a-f]{16}-graffiticode-(.+)-\d+$/.exec(reference)?.[1] ?? null;

// The source cases (boundary, source-change): the recorded L0185 output names
// the tag that was fetched before the change, and every saved reference in
// the artifact was sent under exactly that tag. No substring match: a tag and
// its successor never compare equal.
export const sourceProblems = ({ recordedOutputText, artifact, oldTag }) => {
  const problems = [];
  let recordedTag = null;
  try {
    // The source is `{"label": <tag>}` (scripts/b6-drive.js, fromSource).
    recordedTag = JSON.parse(recordedOutputText ?? "null")?.data?.label ?? null;
  } catch {
    recordedTag = null;
  }
  if (recordedTag !== oldTag) problems.push(`the recorded L0185 output's tag is ${JSON.stringify(recordedTag)}, not ${JSON.stringify(oldTag)}`);
  const references = savedReferences(artifact);
  if (references.length === 0) problems.push("the artifact has no saved reference");
  for (const r of references) {
    if (lrnIdOf(r) !== oldTag) problems.push(`${r} wasn't sent under ${oldTag}`);
  }
  return problems;
};

// The lower stage rebuilt by replay (the dropped phase's lower-lost case):
// the api logs that materialization under the original command, and the
// repair's own run under the repair.
export const lowerRebuildProblems = ({ originalLines = [], repairLines = [] }) => {
  const problems = [];
  if (!originalLines.some(l => l.includes(": call materialize s1 "))) problems.push("no `call materialize s1` under the original");
  if ([...originalLines, ...repairLines].some(l => l.includes(": call start s1 "))) problems.push("the lower stage was started");
  if (!repairLines.some(l => l.includes(": call start s0 "))) problems.push("no `call start s0` under the repair");
  return problems;
};

// No write repeated, with complete evidence. Each operation is
// { occurrence, opid, kind, outcome, source, audit: { claims, dispatches: { <step>: n } } }:
//   kind "original"  an occurrence the original bound;
//   kind "repair"    one a repair bound;
//   kind "answered"  an occurrence of the repaired stage that the repair
//                    didn't bind: answered from its record, so no operation.
// Expected: an operation recorded from a receipt (source "receipt") has
// exactly one claim, and one refused by Policy or at bind has none. A
// completed, partial or uncertain write has at least one dispatch, a failed
// one none, and no provider step is dispatched twice under one operation id.
// An "answered" operation has no claim and no dispatch. Each occurrence is
// dispatched under at most one operation id. Missing audit is a problem, not
// a pass.
export const dispatchProblems = operations => {
  const problems = [];
  const byOccurrence = new Map();
  for (const op of operations) {
    const audit = op.audit;
    if (!audit) {
      problems.push(`${op.opid}: no audit read`);
      continue;
    }
    const steps = Object.entries(audit.dispatches ?? {});
    const dispatched = steps.reduce((n, [, c]) => n + c, 0);
    for (const [step, count] of steps) if (count > 1) problems.push(`${op.opid}: step ${step} dispatched ${count} times`);
    if (op.kind === "answered") {
      if (audit.claims !== 0 || dispatched !== 0) problems.push(`${op.opid}: answered from its record, yet ${audit.claims} claim(s) and ${dispatched} dispatch(es)`);
    } else {
      const fromReceipt = op.source === "receipt";
      const expectedClaims = fromReceipt ? 1 : 0;
      if (audit.claims !== expectedClaims) problems.push(`${op.opid}: ${audit.claims} claim(s), expected ${expectedClaims} (${op.outcome ?? "no outcome"} from ${op.source ?? "nothing"})`);
      if (fromReceipt && ["completed", "partial", "uncertain"].includes(op.outcome) && dispatched === 0) problems.push(`${op.opid}: a ${op.outcome} write with no dispatch evidence`);
      if (op.outcome === "failed" && dispatched !== 0) problems.push(`${op.opid}: a failed write with ${dispatched} dispatch(es)`);
      if (!op.outcome) problems.push(`${op.opid}: no recorded outcome`);
    }
    if (!byOccurrence.has(op.occurrence)) byOccurrence.set(op.occurrence, []);
    if (dispatched > 0) byOccurrence.get(op.occurrence).push(op.opid);
  }
  for (const [occurrence, opids] of byOccurrence) {
    if (opids.length > 1) problems.push(`${occurrence}: dispatched under ${opids.length} operation ids (${opids.join(", ")})`);
  }
  return problems;
};

// Broker's audit entries (Cloud Logging, jsonPayload), counted per operation:
// claims (execute, not a replay or a denial) and dispatches by step
// (execute-step with purpose dispatch).
export const auditByOperation = (entries, opids) => {
  const found = new Map(opids.map(o => [o, { claims: 0, replays: 0, dispatches: {} }]));
  for (const entry of entries) {
    const p = entry?.jsonPayload ?? {};
    const at = found.get(p.opid);
    if (!at) continue;
    if (p.event === "execute-step" && p.purpose === "dispatch") at.dispatches[p.step ?? "?"] = (at.dispatches[p.step ?? "?"] ?? 0) + 1;
    else if (p.event === "execute" && p.outcome === "replayed") at.replays++;
    // A write's own execute record: its outcome, once (Broker audits the
    // maintenance canary's admission separately, which isn't a claim).
    else if (p.event === "execute" && p.outcome !== "denied" && p.reason !== "canary-during-maintenance") at.claims++;
  }
  return found;
};

// What the drive must have exercised (the owner's review of 08fc309b): a
// phase passing proves nothing if it had nothing to do. Minimum cases per
// scenario, read from the drive's own records.
export const MINIMUM_ORIGINALS = Object.freeze({
  "failed-only": 6, exclusion: 1, resume: 2, "head-lost": 2, "lower-lost": 2, "source-change": 2, partly: 2, "partial-probe": 1,
});
export const MINIMUM_COUNTED_REPAIRS = Object.freeze({ "failed-only": 6, partly: 2, resume: 2, "lower-lost": 2, exclusion: 1 });
export const REQUIRED_PROBES = Object.freeze(["completed", "partial", "uncertain", "uncertain, no selection"]);

// The originals a phase works on, at least `minimum` of them, or why not.
export const caseProblems = (originals, purpose, minimum = MINIMUM_ORIGINALS[purpose]) => {
  const n = originals.filter(o => o.purpose === purpose).length;
  return n >= minimum ? [] : [`${purpose}: ${n} original(s), at least ${minimum} needed`];
};

// Every scenario the gate requires, with its evidence, from the state.
export const scenarioProblems = state => {
  const problems = [];
  const originals = state.originals ?? [];
  for (const purpose of Object.keys(MINIMUM_ORIGINALS)) problems.push(...caseProblems(originals, purpose));
  const counted = [...new Map((state.repairs ?? []).filter(r => r.counted).map(r => [r.repairId, r])).values()];
  for (const [purpose, minimum] of Object.entries(MINIMUM_COUNTED_REPAIRS)) {
    const n = counted.filter(r => r.purpose === purpose).length;
    if (n < minimum) problems.push(`${purpose}: ${n} counted repair(s), at least ${minimum} needed`);
  }
  const lowerLost = counted.filter(r => r.purpose === "lower-lost");
  if (lowerLost.some(r => !Array.isArray(r.problems) || r.problems.length > 0)) problems.push("lower-lost: a repair without its rebuild evidence");
  for (const what of REQUIRED_PROBES) {
    const probe = (state.probes ?? []).filter(p => p.what === what).at(-1);
    const expected = what === "uncertain, no selection" ? "nothing-to-repair" : "not-eligible";
    if (!probe) problems.push(`probe ${what}: never run`);
    else if (probe.httpStatus !== 409 || probe.reason !== expected || JSON.stringify(probe.before) !== JSON.stringify(probe.after)) problems.push(`probe ${what}: not refused ${expected} with nothing claimed`);
  }
  const materialized = state.materialized ?? [];
  for (const purpose of ["head-lost", "source-change"]) {
    const ok = materialized.filter(m => m.purpose === purpose && m.published === "current" && Array.isArray(m.problems) && m.problems.length === 0);
    const distinct = new Set(ok.map(m => m.commandId)).size;
    if (distinct < 2) problems.push(`${purpose}: ${distinct} materialization(s) with complete evidence, at least 2 needed`);
  }
  const boundary = (state.boundary ?? []).filter(b => Array.isArray(b.problems) && b.problems.length === 0);
  if (boundary.length < 2) problems.push(`boundary: ${boundary.length} case(s) with complete evidence, at least 2 needed`);
  for (const o of originals.filter(x => x.fault === "drop-outcome")) {
    const verdicts = o.reconciled?.verdicts ?? [];
    if (!verdicts.length || !verdicts.every(v => v.verdict === "applied" && v.final === true)) problems.push(`${o.key}: not reconciled applied`);
  }
  const retried = new Set((state.retries ?? []).filter(r => r.same && r.outcome === "completed").map(r => r.repairId));
  for (const r of counted) if (!retried.has(r.repairId)) problems.push(`${r.repairId}: never retried by its key`);
  return problems;
};

// Ledger exclusion (plan slice 5, case 5), judged from the records, not from
// the HTTP status: the api answers 200 once it has allocated a repair, and
// Policy's admission runs after that, so a repair that lost the race is a 200
// whose answer is `outcome: "failed"` with `reason: "occurrence-claimed"` (or
// `nothing-to-repair` once the winner finished), or a 409 refused before
// allocation. Each request is { key, answer, state, claims, audit }:
//   answer  what POST /command/:id/repair answered ({ status, data, error }),
//           or null when the run is re-judged from its records;
//   state   Policy's state record of the repair it allocated, or null;
//   claims  Broker's receipts under that repair's invocation;
//   audit   Broker's audit for that repair's operation ids (auditByOperation).
// `ledger` is the original's ledger for the occurrence the race was over.
export const EXCLUSION_LOSER_REASONS = Object.freeze(["occurrence-claimed", "nothing-to-repair"]);
export const exclusionProblems = ({ requests = [], ledger = [] }) => {
  const problems = [];
  const reasonOf = r => r.state?.admissionRefusal?.reason ?? r.answer?.data?.reason ?? r.answer?.error?.reason ?? null;
  const admitted = requests.filter(r => r.state && !r.state.admissionRefusal && r.state.admission);
  if (admitted.length !== 1) problems.push(`${admitted.length} of ${requests.length} repairs admitted, expected exactly 1`);
  const winner = admitted.length === 1 ? admitted[0] : null;
  for (const r of requests) {
    if (r === winner) continue;
    const reason = reasonOf(r);
    if (!EXCLUSION_LOSER_REASONS.includes(reason)) problems.push(`${r.key}: refused ${JSON.stringify(reason)}, not ${EXCLUSION_LOSER_REASONS.join(" or ")}`);
    if (r.answer && r.answer.status === 200 && r.answer.data?.outcome !== "failed") problems.push(`${r.key}: answered 200 with outcome ${JSON.stringify(r.answer.data?.outcome)}, not failed`);
    if (r.answer && r.answer.status !== 200 && r.answer.status !== 409) problems.push(`${r.key}: answered ${r.answer.status}`);
    if (r.state && Object.keys(r.state.stages ?? {}).length > 0) problems.push(`${r.key}: refused, yet it has stages`);
    if ((r.claims ?? []).length !== 0) problems.push(`${r.key}: refused, yet ${r.claims.length} Broker claim(s)`);
    const dispatched = [...(r.audit?.values?.() ?? [])].reduce((n, a) => n + a.claims + Object.values(a.dispatches).reduce((m, c) => m + c, 0), 0);
    if (dispatched !== 0) problems.push(`${r.key}: refused, yet ${dispatched} Broker audit claim(s) or dispatch(es)`);
  }
  if (ledger.length !== 1) problems.push(`the ledger has ${ledger.length} entries, expected 1`);
  else if (winner && ledger[0].repairId !== winner.state.commandId) problems.push(`the ledger's entry is held by ${ledger[0].repairId}, not the admitted repair ${winner.state.commandId}`);
  else if (ledger[0].status !== "completed") problems.push(`the ledger's entry is ${ledger[0].status}, not completed`);
  if (winner) {
    if (winner.state.status !== "completed" || winner.state.publication?.state !== "published") problems.push(`the admitted repair is ${winner.state.status}, publication ${winner.state.publication?.state}`);
    if ((winner.claims ?? []).length !== 1) problems.push(`the admitted repair has ${(winner.claims ?? []).length} Broker claim(s), expected 1`);
    const audits = [...(winner.audit?.values?.() ?? [])];
    const writes = audits.filter(a => Object.keys(a.dispatches).length > 0).length;
    if (writes !== 1) problems.push(`the admitted repair made ${writes} write(s), expected 1`);
    for (const a of audits) for (const [step, c] of Object.entries(a.dispatches)) if (c > 1) problems.push(`the admitted repair dispatched ${step} ${c} times`);
  }
  return problems;
};
