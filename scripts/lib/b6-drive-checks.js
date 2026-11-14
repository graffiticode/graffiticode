// The B6 drive's verdicts (scripts/b6-drive.js), as pure functions over what it
// read, so each can be tested offline before the live drive (the owner's
// review of #390). Nothing here reads a service.

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
    recordedTag = JSON.parse(recordedOutputText ?? "null")?.data?.tag ?? null;
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
