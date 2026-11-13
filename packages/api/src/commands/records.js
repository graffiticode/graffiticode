// An original command's records as its repairs left them (B6, docs/b6-command-
// repair-plan.md decisions 4–7), read through Policy's gateway reads: its
// state (with the canonical snapshot), models, and each occurrence's current
// outcome, the argument digest it was bound with, and its recorded output.
//
//   readOriginal({ policy, commandId, step? }) -> view
//   recordedFor(view, stage, holder) -> { completed, blocked }
//     what a stage's start (7a) or materialization (decision 6) is given: every
//     completed occurrence with a usable output, by its digest and result; and
//     every other recorded occurrence of the stage, blocked. `holder`'s own
//     claims are neither: they execute.
//   completeness(view) -> null | { reason, stage?, occurrenceId? }
//     why the original can't be materialized: an occurrence not completed
//     (`not-complete`), one completed whose output can't be used
//     (`output-unavailable`), or a stage never reached (`not-complete`).
//   materializeFromRecords({ policy, language, view, stage }) -> { ok, envelope } | refusal
//     one stage rebuilt from its records (decision 6)
//   materializeCommand({ policy, language, artifactStorer, commandId, registryVersion, form })
//     -> { ok, published } | { ok: false, reason, stage?, occurrenceId? }
//     the whole chain rebuilt from its records and stored as the original
//     invocation's artifact (decisions 8, 9)

import { canonicalStages, repairGate } from "@graffiticode/policy/records";

const key = (stage, occurrenceId) => `${stage}:${occurrenceId}`;
const SETTLED = new Set(["completed", "failed", "partial", "uncertain"]);

export const readOriginal = async ({ policy, commandId, step = f => f() }) => {
  const read = what => step(() => policy.read({ commandId, what }));
  const [state, { models }, { occurrences }, { outcomes }, { refusals }, { ledger }] = await Promise.all([
    read("state"), read("models"), read("occurrences"), read("outcomes"), read("refusals"), read("ledger"),
  ]);
  const all = new Map();
  const at = (stage, occurrenceId) => {
    const k = key(stage, occurrenceId);
    if (!all.has(k)) all.set(k, { stage, occurrenceId, original: null, entry: null, argd: null, originalOutput: null });
    return all.get(k);
  };
  for (const o of occurrences) at(o.stage, o.occurrenceId).argd = o.argd ?? null;
  for (const o of outcomes) Object.assign(at(o.stage, o.occurrenceId), { original: o.outcome, originalOutput: o.output ?? null });
  for (const r of refusals) {
    const occ = at(r.stage, r.occurrenceId);
    if (!occ.original) occ.original = "failed";
  }
  for (const e of ledger) at(e.stage, e.occurrenceId).entry = e;
  for (const occ of all.values()) {
    const settled = occ.entry && SETTLED.has(occ.entry.status);
    occ.current = settled ? occ.entry.status : (occ.entry?.prior ?? occ.original);
    occ.heldBy = occ.entry?.status === "pending" ? occ.entry.repairId : null;
    occ.argd = occ.argd ?? occ.entry?.argd ?? null;
    occ.output = settled && occ.entry.status === "completed" ? occ.entry.output ?? null : occ.originalOutput;
  }
  return {
    state,
    stages: canonicalStages(state),
    models: new Map(models.map(m => [m.stage, JSON.parse(m.text)])),
    occurrences: [...all.values()],
  };
};

// An output a record can answer with: its exact text.
const usable = output => typeof output?.text === "string";

export const recordedFor = (view, stage, holder = null) => {
  const completed = {};
  const blocked = [];
  for (const occ of view.occurrences.filter(o => o.stage === stage)) {
    if (holder && occ.heldBy === holder) continue;
    if (occ.current === "completed" && occ.argd && usable(occ.output)) {
      completed[occ.occurrenceId] = { argd: occ.argd, result: JSON.parse(occ.output.text) };
    } else {
      blocked.push(occ.occurrenceId);
    }
  }
  return { completed, blocked };
};

export const completeness = view => {
  for (const occ of view.occurrences) {
    if (occ.current !== "completed") return { reason: "not-complete", stage: occ.stage, occurrenceId: occ.occurrenceId };
    if (!occ.argd || !usable(occ.output)) return { reason: "output-unavailable", stage: occ.stage, occurrenceId: occ.occurrenceId };
  }
  for (const stage of Object.keys(view.state.admission?.stages ?? {})) {
    if (view.stages[stage]?.state === "not-reached") return { reason: "not-complete", stage };
  }
  return null;
};

const executionOrder = view => Object.keys(view.state.admission?.stages ?? {}).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));

// One stage rebuilt from its records (decision 6): its admitted model, at its
// pinned revision, on its canonical pinned input, every occurrence answered
// from its record. The kernel's replay acts on nothing. Anything the records
// can't answer is refused before it is asked.
export const materializeFromRecords = async ({ policy, language, view, stage, log = _line => {} }) => {
  const id = view.state.commandId;
  const admitted = view.state.admission.stages[stage];
  const { input: pinned } = await policy.read({ commandId: id, what: "input", stage });
  if (!pinned) return { ok: false, reason: "not-recorded", stage };
  const recorded = recordedFor(view, stage);
  if (recorded.blocked.length > 0) {
    const occurrenceId = recorded.blocked[0];
    const occ = view.occurrences.find(o => o.stage === stage && o.occurrenceId === occurrenceId);
    return { ok: false, reason: occ?.current === "completed" ? "output-unavailable" : "not-complete", stage, occurrenceId };
  }
  log(`command ${id}: call materialize ${stage} L${admitted.lang} at ${admitted.tagUrl}`);
  const answer = await language.materialize({ lang: admitted.lang, model: view.models.get(stage), input: JSON.parse(pinned.text), recorded, baseUrl: admitted.tagUrl });
  if (answer?.responseLost) return { ok: false, reason: "unavailable", stage };
  if (Array.isArray(answer?.errors) && answer.errors.length > 0) {
    log(`WARN command ${id}: ${stage}'s materialization failed (${answer.errors.map(e => e?.code ?? e?.message).join(", ")})`);
    return { ok: false, reason: "materialize-failed", stage };
  }
  return { ok: true, envelope: { data: answer?.data ?? null, errors: [] } };
};

// The chain, right to left (decision 6, "The chain"): a stage with intents is
// replayed from its pinned input and occurrences; one without takes its
// recorded output. The head's data is the result.
const materializeChain = async ({ policy, language, view, log }) => {
  let envelope = null;
  for (const stage of executionOrder(view)) {
    if ((view.state.admission.stages[stage].intents ?? []).length > 0) {
      const out = await materializeFromRecords({ policy, language, view, stage, log });
      if (!out.ok) return out;
      envelope = out.envelope;
    } else {
      const { output } = await policy.read({ commandId: view.state.commandId, what: "output", stage });
      if (!output) return { ok: false, reason: "not-recorded", stage };
      log(`command ${view.state.commandId}: ${stage} from its recorded output, not run`);
      envelope = JSON.parse(output.text);
    }
  }
  return { ok: true, data: envelope?.data ?? null };
};

// Decision 9: a command whose every occurrence completed (across its repairs
// and reconciliation) and whose every stage was reached, but which has no
// artifact (its head's answer was lost, or its last write was reconciled), is
// rebuilt from its records and stored as its own invocation's artifact. Both
// eligibility gates apply. An artifact already stored for the invocation is
// the answer, and is never rebuilt; storing never replaces a newer
// invocation's (the head's compare-and-set).
export const materializeCommand = async ({ policy, language, artifactStorer, commandId, registryVersion, form, log = _line => {} }) => {
  const view = await readOriginal({ policy, commandId });
  const gate = repairGate(view.state);
  if (gate) return { ok: false, reason: gate };
  const missing = completeness(view);
  if (missing) return { ok: false, ...missing };
  const { state } = view;
  if (await artifactStorer.getByInvocation(state.invocationId)) return { ok: true, published: "already" };
  const out = await materializeChain({ policy, language, view, log });
  if (!out.ok) return out;
  const stored = await artifactStorer.put({
    uid: state.uid,
    ownerUid: state.ownerUid,
    connectionId: state.connectionId,
    taskId: state.taskId,
    invocationId: state.invocationId,
    seq: state.seq,
    registryVersion,
    form,
    content: out.data,
  });
  return { ok: true, published: stored.current ? "current" : "superseded" };
};
