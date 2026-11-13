// A command's records after allocation (B5 slice 2, docs/b5-commands-plan.md
// §3–§7): models, pinned inputs, observations, occurrences, outcomes, the
// issuance log, the result and the publication.
//
// Two kinds of write:
//   - Owner writes (fenced): models, inputs, observations, occurrence binds,
//     stage close, the issuance log. Each runs in a transaction that re-reads
//     the command and needs a live lease and exactly the current generation
//     (`ownerRefusal`). A refused write changes nothing.
//   - Bookkeeping (also fenced, no live permission): outcomes, finish,
//     published. They record what already happened.
//
// Payloads (models, inputs, observations, occurrence arguments, the result)
// are stored as their exact JSON text, never re-serialized (decision 2).
// Install-once writes return what is installed, so a retry or a later owner
// always reads the first value.
//
// Repairs (B6 slice 3, docs/b6-command-repair-plan.md decisions 1, 3, 4, 7, 11):
//   - The ledger, `commands/{original}/ledger/{stage}:{occurrence}`, holds
//     each occurrence a repair has claimed or reconciliation has settled:
//     `pending` while a repair holds it, then the repair's outcome for it
//     (`completed`, `failed`, `partial`, `uncertain`), with the repair's
//     receipt and output. An occurrence's current outcome is its ledger
//     entry's when that is settled, otherwise the original's own.
//   - A repair claims every occurrence it selected in one transaction, with
//     its admission (`claimRepair`); each must be `failed` now and held by no
//     other repair. An occurrence new to a stage is claimed when it is bound.
//   - A repair's bind refuses an occurrence the records hold that the repair
//     doesn't (`not-selected`), and arguments other than the original
//     binding's (`binding-mismatch`). Bounds count every occurrence of the
//     stage across the original and its repairs.
//   - Finishing a repair settles the entries it held.
//   - Reconciliation records an applied, final verdict for an uncertain
//     occurrence as `completed`, with its output or `unavailable`.
//
// The logic is written once against a small transaction interface, which the
// memory and Firestore backends implement:
//   backend.transaction(async tx => …)
//     tx.get(path) -> doc | null      tx.set(path, doc)      tx.list(path) -> [doc]
//   where a path is ["commands", id] or ["commands", id, collection, docId]
//   (list takes ["commands", id, collection]).

import { createHash } from "node:crypto";
import { CommandRefused, MAX_PAYLOAD_BYTES, ownerRefusal } from "./commands.js";
import { aggregateStatus, outcomeFromReceipt } from "./command-outcomes.js";

export const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");
const STAGE_RE = /^s\d{1,3}$/;
const OCC_RE = /^[A-Za-z0-9_:.-]{1,200}$/;
const OID_RE = /^o:[a-f0-9]{64}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
export const RUNTIME_PREFIX = "x:";

// A runtime occurrence's id: one segment, recomputed from its fields on every
// check (plan B5, "Admission of runtime-expanded effects").
export const runtimeOccurrenceId = (intentId, expansionKey) => `${RUNTIME_PREFIX}${sha256(JSON.stringify({ intentId, expansionKey }))}`;
export const observationId = (stage, key) => `o:${sha256(JSON.stringify({ stage, key }))}`;

const payloadProblem = text => {
  if (typeof text !== "string") return "bad-request";
  if (Buffer.byteLength(text, "utf8") > MAX_PAYLOAD_BYTES) return "input-too-large";
  try {
    JSON.parse(text);
  } catch {
    return "bad-request";
  }
  return null;
};
const requirePayload = text => {
  const problem = payloadProblem(text);
  if (problem) throw new CommandRefused(problem);
};
const requireStage = stage => {
  if (typeof stage !== "string" || !STAGE_RE.test(stage)) throw new CommandRefused("bad-request");
};
const docKey = (stage, occurrenceId) => `${stage}:${occurrenceId}`;
// The stage below `stage` in the chain: its upstream, which runs before it
// (`s0` is the head; `s<n+1>` feeds `s<n>`).
const stageBelow = stage => `s${Number(stage.slice(1)) + 1}`;
// B6 (decision 5): an operation's result as recorded text, or why there is
// none. `undefined` is "not reported" (a receipt before B6, or a claim with no
// outcome); null is a write that returned nothing.
const outputOf = result => {
  if (result === undefined) return {};
  const text = JSON.stringify(result);
  if (Buffer.byteLength(text, "utf8") > MAX_PAYLOAD_BYTES) return { output: { tooLarge: true } };
  return { output: { text, digest: sha256(text) } };
};

// An occurrence's outcomes, settled or held, in the ledger.
const SETTLED = new Set(["completed", "failed", "partial", "uncertain"]);

// Why a command can't be repaired, or null (decision 11, before any claim):
// it must be an original command, finished, admitted on revisions that
// replay (every intent-bearing stage's own preflight said `replay: 1`), and
// recorded (`recording: 1`), with what the repair and the assembly need:
// every stage that ran has its output, or for a stage with intents its
// pinned input, and every stage with a selected occurrence its pinned input.
export const repairGate = (original, selection = []) => {
  if (!original) return "command-not-found";
  if ((original.kind ?? "command") !== "command") return "not-original";
  if (original.status === "pending") return "command-pending";
  const admission = original.admission;
  if (original.phase !== "admitted" || !admission) return "not-admitted";
  const stages = Object.entries(admission.stages ?? {}) as [string, { intents?: unknown[], replay?: number }][];
  if (stages.some(([, a]) => (a.intents ?? []).length > 0 && a.replay !== 1)) return "revision-unsupported";
  if (admission.recording !== 1) return "not-recorded";
  for (const [name, a] of stages) {
    const own = original.stages?.[name] ?? {};
    if (own.state === "not-reached") continue;
    const hasIntents = (a.intents ?? []).length > 0;
    // An output too large to record (`"too-large"`) is no output.
    const output = typeof own.output === "string" && DIGEST_RE.test(own.output);
    if (!output && !(hasIntents && typeof own.pinnedInput === "string")) return "not-recorded";
  }
  for (const { stage } of selection) {
    if (typeof original.stages?.[stage]?.pinnedInput !== "string") return "not-recorded";
  }
  return null;
};

export const createCommandRecords = ({ backend, now = () => Date.now() }) => {
  const cmdPath = id => ["commands", id];
  const sub = (id, collection, docId) => ["commands", id, collection, docId];
  // An owner's transaction: the command must be theirs, now.
  const owned = (commandId, generation, fn) => backend.transaction(async tx => {
    const command = await tx.get(cmdPath(commandId));
    const refusal = ownerRefusal(command, { generation, now: now() });
    if (refusal) throw new CommandRefused(refusal);
    return fn(tx, command);
  });
  const touch = (tx, command, patch) => {
    const next = { ...command, ...patch, updatedAt: new Date(now()).toISOString() };
    tx.set(cmdPath(command.commandId), next);
    return next;
  };
  const installOnce = async (tx, path, doc) => {
    const existing = await tx.get(path);
    if (existing) return { installed: existing, created: false };
    tx.set(path, doc);
    return { installed: doc, created: true };
  };
  const stageOf = (command, stage) => command.stages?.[stage] ?? { state: "pending", expansion: "open", pinnedInput: null };
  const admittedIntents = (command, stage) => command.admission?.stages?.[stage]?.intents ?? null;
  const at = () => new Date(now()).toISOString();

  // Every occurrence of an original command, with its current outcome (B6
  // decisions 1 and 4): `current` is the ledger's settled outcome, else the
  // original's own (a refused bind is `failed`, a bound one with no outcome
  // null); `heldBy` names the repair holding it, if one does.
  const occurrenceStates = async (tx, originalId) => {
    const occurrences = await tx.list(["commands", originalId, "occurrences"]);
    const outcomes = await tx.list(["commands", originalId, "outcomes"]);
    const refusals = await tx.list(["commands", originalId, "refusals"]);
    const ledger = await tx.list(["commands", originalId, "ledger"]);
    const states = new Map();
    const state = (stage, occurrenceId) => {
      const k = docKey(stage, occurrenceId);
      if (!states.has(k)) states.set(k, { stage, occurrenceId, original: null, entry: null });
      return states.get(k);
    };
    for (const o of occurrences) state(o.stage, o.occurrenceId).bound = true;
    for (const o of outcomes) state(o.stage, o.occurrenceId).original = o.outcome;
    for (const r of refusals) {
      const st = state(r.stage, r.occurrenceId);
      if (!st.original) st.original = "failed";
    }
    for (const e of ledger) state(e.stage, e.occurrenceId).entry = e;
    for (const st of states.values()) {
      st.current = st.entry && SETTLED.has(st.entry.status) ? st.entry.status : (st.entry?.prior ?? st.original);
      st.heldBy = st.entry?.status === "pending" ? st.entry.repairId : null;
    }
    return states;
  };

  return {
    // §6 step 2: a stage's model, installed once with its revision.
    installModel: ({ commandId, generation, stage, text, revision, tagUrl }) => owned(commandId, generation, async (tx, command) => {
      requireStage(stage);
      requirePayload(text);
      if (command.phase === "admitted") throw new CommandRefused("command-admitted");
      const { installed } = await installOnce(tx, sub(commandId, "models", stage), { stage, text, digest: sha256(text), revision: revision ?? null, tagUrl: tagUrl ?? null });
      if (command.phase === "allocated") touch(tx, command, { phase: "initializing" });
      return { stage, digest: installed.digest, revision: installed.revision, tagUrl: installed.tagUrl };
    }),

    // §6 step 2: admission recorded on the command, once. A retry of the same
    // admission is acknowledged; a different one is refused.
    admit: ({ commandId, generation, admission }) => owned(commandId, generation, async (tx, command) => {
      if (command.phase === "admitted") {
        if (command.admission?.planDigest !== admission.planDigest) throw new CommandRefused("plan-mismatch");
        return command;
      }
      const stages = Object.fromEntries(Object.keys(admission.stages).map(name => [name, { ...stageOf(command, name) }]));
      return touch(tx, command, { phase: "admitted", admission, stages, revisions: admission.revisions ?? null });
    }),

    // §6 step 2, refused: why Policy refused this command's admission (a
    // permission no longer granted, a revision retired, ...), recorded for the
    // command's callers. Only before admission; the first reason stays.
    refuseAdmission: ({ commandId, generation, reason }) => owned(commandId, generation, async (tx, command) => {
      if (typeof reason !== "string" || !reason) throw new CommandRefused("bad-request");
      if (command.phase === "admitted") throw new CommandRefused("command-admitted");
      if (command.admissionRefusal) return command;
      return touch(tx, command, { admissionRefusal: { reason, at: new Date(now()).toISOString() } });
    }),

    // §5: a stage's pinned input, installed once; a later owner gets the first.
    // A command that records outputs (B6, decision 5) pins exactly the output
    // recorded for the stage below: the two can't diverge.
    installInput: ({ commandId, generation, stage, text }) => owned(commandId, generation, async (tx, command) => {
      requireStage(stage);
      requirePayload(text);
      if (command.phase !== "admitted") throw new CommandRefused("not-admitted");
      if (command.admission?.recording === 1) {
        const below = stageOf(command, stageBelow(stage)).output;
        if (typeof below === "string" && below !== sha256(text)) throw new CommandRefused("input-not-output");
      }
      const { installed, created } = await installOnce(tx, sub(commandId, "inputs", stage), { stage, text, digest: sha256(text) });
      if (created) {
        const stages = { ...command.stages, [stage]: { ...stageOf(command, stage), pinnedInput: installed.digest } };
        touch(tx, command, { stages });
      }
      return { stage, digest: installed.digest, text: installed.text };
    }),

    // B6 (decision 5): a stage's output envelope, installed once, by digest, and
    // named on the stage. A second install of the same output is acknowledged;
    // another is refused. An output over the payload limit is recorded as too
    // large, never truncated: that stage can't be materialized, and recovery
    // above it falls back to the pinned input.
    installOutput: ({ commandId, generation, stage, text }) => owned(commandId, generation, async (tx, command) => {
      requireStage(stage);
      if (command.phase !== "admitted") throw new CommandRefused("not-admitted");
      if (!command.admission?.stages?.[stage]) throw new CommandRefused("bad-request");
      const problem = payloadProblem(text);
      if (problem === "input-too-large") {
        if (stageOf(command, stage).output === undefined) {
          touch(tx, command, { stages: { ...command.stages, [stage]: { ...stageOf(command, stage), output: "too-large" } } });
        }
        return { stage, tooLarge: true };
      }
      if (problem) throw new CommandRefused(problem);
      const digest = sha256(text);
      const { installed, created } = await installOnce(tx, sub(commandId, "outputs", stage), { stage, text, digest });
      if (!created) {
        if (installed.digest !== digest) throw new CommandRefused("output-conflict");
        return { stage, digest };
      }
      touch(tx, command, { stages: { ...command.stages, [stage]: { ...stageOf(command, stage), output: digest } } });
      return { stage, digest };
    }),

    // §5: one observation, installed once. Without `text`, finds it.
    observation: ({ commandId, generation, stage, key, text = undefined }) => owned(commandId, generation, async tx => {
      requireStage(stage);
      if (typeof key !== "string" || !key || key.length > 512) throw new CommandRefused("bad-request");
      const oid = observationId(stage, key);
      const path = sub(commandId, "observations", oid);
      if (text === undefined) {
        const found = await tx.get(path);
        return found ? { observationId: oid, recorded: true, text: found.text } : { observationId: oid, recorded: false };
      }
      requirePayload(text);
      const { installed } = await installOnce(tx, path, { observationId: oid, stage, key, text, digest: sha256(text) });
      return { observationId: oid, recorded: true, text: installed.text };
    }),

    // §4: an occurrence bound to its admitted intent before dispatch. Bounds
    // are enforced here, in the same transaction as the per-intent count.
    bindOccurrence: ({ commandId, generation, stage, occurrenceId, intentId, expansionKey = null, args, argd = null, observations = [] }) => owned(commandId, generation, async (tx, command) => {
      requireStage(stage);
      if (typeof occurrenceId !== "string" || !OCC_RE.test(occurrenceId) || typeof intentId !== "string" || !intentId) throw new CommandRefused("bad-request");
      requirePayload(args);
      // `argd`: the Broker's digest of the operation's payload, which mint
      // and authorize-execution check the token's against.
      if (argd !== null && (typeof argd !== "string" || !DIGEST_RE.test(argd))) throw new CommandRefused("bad-request");
      if (!Array.isArray(observations) || !observations.every(o => typeof o === "string" && OID_RE.test(o))) throw new CommandRefused("bad-request");
      const intents = admittedIntents(command, stage);
      if (!intents) throw new CommandRefused("not-admitted");
      // A repair's bind (B6 7a, 7b) also reads the original's records of this
      // occurrence and its ledger entry, before anything is written.
      const repair = command.kind === "repair";
      const key = docKey(stage, occurrenceId);
      const original = repair ? await tx.get(cmdPath(command.repairOf)) : null;
      const originalBound = repair ? await tx.get(sub(command.repairOf, "occurrences", key)) : null;
      const originalRecorded = repair && Boolean(originalBound || await tx.get(sub(command.repairOf, "outcomes", key)) || await tx.get(sub(command.repairOf, "refusals", key)));
      const ledgerPath = repair ? sub(command.repairOf, "ledger", key) : null;
      const entry = repair ? await tx.get(ledgerPath) : null;
      // A definite refusal of this occurrence is recorded, in this transaction,
      // before it is answered (C6 slice 0): finish counts it failed, so a
      // command with a refused save is never completed. Idempotent: a resumed
      // run's same bind meets the record and is refused alike.
      const refusalPath = sub(commandId, "refusals", docKey(stage, occurrenceId));
      const prior = await tx.get(refusalPath);
      if (prior) return { stage, occurrenceId, refused: prior.reason };
      const refuse = reason => {
        tx.set(refusalPath, { stage, occurrenceId, intentId, expansionKey, reason, at: new Date(now()).toISOString(), generation });
        return { stage, occurrenceId, refused: reason };
      };
      const intent = intents.find(i => i.id === intentId);
      if (!intent) return refuse("intent-not-admitted");
      const runtime = occurrenceId.startsWith(RUNTIME_PREFIX);
      if (runtime) {
        if (typeof expansionKey !== "string" || occurrenceId !== runtimeOccurrenceId(intentId, expansionKey)) return refuse("occurrence-mismatch");
      } else if (expansionKey !== null || !(intent.occurrences ?? []).includes(occurrenceId)) {
        return refuse("occurrence-mismatch");
      }
      const argsDigest = sha256(args);
      const path = sub(commandId, "occurrences", docKey(stage, occurrenceId));
      const existing = await tx.get(path);
      // A rebind of what is already bound is acknowledged, even once the stage
      // is closed: a resumed stage presents its recorded occurrences again.
      if (existing) {
        if (existing.argsDigest !== argsDigest || existing.intentId !== intentId) throw new CommandRefused("operation-id-reused");
        return { stage, occurrenceId, argsDigest, bound: false };
      }
      if (stageOf(command, stage).expansion === "closed" && runtime) throw new CommandRefused("stage-closed");
      for (const oid of observations) {
        if (!(await tx.get(sub(commandId, "observations", oid)))) throw new CommandRefused("observation-not-recorded");
      }
      const countKey = `${stage}/${intentId}`;
      const counts = { ...(command.counts ?? {}) };
      const byIntent = { ...(counts.byIntent ?? {}) };
      const max = intent.bounds?.maxOccurrences ?? 1;
      if (repair) {
        // An occurrence the records hold is bound only by the repair holding
        // it; one held by another repair is that repair's.
        const mine = entry?.status === "pending" && entry.repairId === commandId;
        if (entry?.status === "pending" && !mine) throw new CommandRefused("occurrence-claimed", { stage, occurrenceId, repairId: entry.repairId });
        if ((originalRecorded || entry) && !mine) throw new CommandRefused("not-selected", { stage, occurrenceId });
        // The original binding's arguments, exactly: the model and input are
        // pinned, so anything else is a bug, and nothing is written.
        const bindingDigest = originalBound?.argsDigest ?? entry?.argsDigest ?? null;
        if (bindingDigest !== null && bindingDigest !== argsDigest) throw new CommandRefused("binding-mismatch", { stage, occurrenceId });
        // Bounds across the original and every repair: an occurrence the
        // original bound is counted already, and one new to the stage once.
        const counted = Boolean(originalBound) || entry?.counted === true;
        if (!counted) {
          const total = (original.counts?.byIntent?.[countKey] ?? 0) + (original.repairCounts?.byIntent?.[countKey] ?? 0);
          if (total >= max) return refuse("bounds-exceeded");
          const repairCounts = { byIntent: { ...(original.repairCounts?.byIntent ?? {}), [countKey]: (original.repairCounts?.byIntent?.[countKey] ?? 0) + 1 } };
          tx.set(cmdPath(original.commandId), { ...original, repairCounts, updatedAt: at() });
        }
        // Claimed at bind when it is new (7b), with its arguments and count.
        tx.set(ledgerPath, {
          ...(entry ?? { stage, occurrenceId, commandId: command.repairOf, status: "pending", repairId: commandId, claim: "bind", claimedAt: at(), attempts: [] }),
          argsDigest,
          counted: true,
          generation,
        });
        byIntent[countKey] = (byIntent[countKey] ?? 0) + 1;
        tx.set(path, { stage, occurrenceId, intentId, expansionKey, args, argsDigest, argd, observations, minted: [], boundAt: at(), generation });
        touch(tx, command, { counts: { ...counts, byIntent, bound: (counts.bound ?? 0) + 1 } });
        return { stage, occurrenceId, argsDigest, bound: true };
      }
      if ((byIntent[countKey] ?? 0) >= max) return refuse("bounds-exceeded");
      byIntent[countKey] = (byIntent[countKey] ?? 0) + 1;
      tx.set(path, { stage, occurrenceId, intentId, expansionKey, args, argsDigest, argd, observations, minted: [], boundAt: new Date(now()).toISOString(), generation });
      touch(tx, command, { counts: { ...counts, byIntent, bound: (counts.bound ?? 0) + 1 } });
      return { stage, occurrenceId, argsDigest, bound: true };
    }),

    // §7: the issuance log, committed before a token leaves Policy.
    logIssuance: ({ commandId, generation, stage, occurrenceId, jti, exp }) => owned(commandId, generation, async tx => {
      const path = sub(commandId, "occurrences", docKey(stage, occurrenceId));
      const occurrence = await tx.get(path);
      if (!occurrence) throw new CommandRefused("occurrence-not-bound");
      tx.set(path, { ...occurrence, minted: [...occurrence.minted, { jti, exp }] });
      return { logged: true };
    }),

    // §4: a stage's expansion closed, with each intent's final occurrence ids.
    closeStage: ({ commandId, generation, stage, occurrences }) => owned(commandId, generation, async (tx, command) => {
      requireStage(stage);
      if (!occurrences || typeof occurrences !== "object") throw new CommandRefused("bad-request");
      const bound = (await tx.list(["commands", commandId, "occurrences"])).filter(o => o.stage === stage);
      const listed = new Set(Object.values(occurrences).flat());
      const boundIds = new Set(bound.map(o => o.occurrenceId));
      if ([...listed].some(id => !boundIds.has(id)) || [...boundIds].some(id => !listed.has(id))) throw new CommandRefused("close-mismatch");
      const stages = { ...command.stages, [stage]: { ...stageOf(command, stage), state: "ran", expansion: "closed" } };
      touch(tx, command, { stages });
      return { stage, expansion: "closed" };
    }),

    // Stages left of where the chain stopped.
    markNotReached: ({ commandId, generation, stages: names }) => owned(commandId, generation, async (tx, command) => {
      const stages = { ...command.stages };
      for (const stage of names) {
        requireStage(stage);
        stages[stage] = { ...stageOf(command, stage), state: "not-reached" };
      }
      touch(tx, command, { stages });
      return { stages: names };
    }),

    // §7 settlement: outcomes from Broker's receipts. A recorded receipt
    // outcome is final; a claim without one is uncertain until it records.
    recordFromReceipts: ({ commandId, generation, operations }) => owned(commandId, generation, async (tx, command) => {
      // Every read first (a Firestore transaction reads before it writes).
      const pending = [];
      for (const op of operations) {
        const [inv, stage, occurrenceId] = String(op.operationId).split("/");
        if (inv !== command.invocationId) continue;
        const occurrence = await tx.get(sub(commandId, "occurrences", docKey(stage, occurrenceId)));
        // Only a bound occurrence of an admitted stage is recorded.
        if (!occurrence) continue;
        const path = sub(commandId, "outcomes", docKey(stage, occurrenceId));
        const existing = await tx.get(path);
        if (existing && (existing.source !== "receipt" || existing.final)) continue;
        // The receipt's steps go with it: what a compile's envelope reports
        // for a write (the C6 bridge answers in that envelope).
        const steps = Array.isArray(op.steps) ? op.steps.filter(x => typeof x === "string") : [];
        // B6 (decision 5): what the operation returned, as Broker recorded it.
        pending.push({ path, outcome: { stage, occurrenceId, outcome: outcomeFromReceipt(op.status), source: "receipt", receipt: op.operationId, final: op.recorded === true, reason: op.reason ?? null, steps, ...(op.recorded === true ? outputOf(op.result) : {}), at: new Date(now()).toISOString(), generation } });
      }
      for (const { path, outcome } of pending) tx.set(path, outcome);
      return { recorded: pending.map(p => p.outcome) };
    }),

    // §6 step 4: a lost response. Bound occurrences of the stage with no
    // outcome become uncertain (`lost-response`). Call after settling.
    recordLost: ({ commandId, generation, stage }) => owned(commandId, generation, async tx => {
      requireStage(stage);
      const bound = (await tx.list(["commands", commandId, "occurrences"])).filter(o => o.stage === stage);
      const pending = [];
      for (const occurrence of bound) {
        const path = sub(commandId, "outcomes", docKey(stage, occurrence.occurrenceId));
        if (await tx.get(path)) continue;
        pending.push({ path, outcome: { stage, occurrenceId: occurrence.occurrenceId, outcome: "uncertain", source: "lost-response", receipt: null, final: true, reason: "compile-response-lost", at: new Date(now()).toISOString(), generation } });
      }
      for (const { path, outcome } of pending) tx.set(path, outcome);
      return { recorded: pending.map(p => p.outcome) };
    }),

    // §7: a definite Policy refusal, recorded `failed` — only when the caller
    // (Policy itself) has shown no attempt wrote or can still write.
    recordRefusal: ({ commandId, generation, stage, occurrenceId, reason }) => owned(commandId, generation, async tx => {
      const path = sub(commandId, "outcomes", docKey(stage, occurrenceId));
      const existing = await tx.get(path);
      if (existing) return { outcome: existing };
      const outcome = { stage, occurrenceId, outcome: "failed", source: "policy-refusal", receipt: null, final: true, reason, at: new Date(now()).toISOString(), generation };
      tx.set(path, outcome);
      return { outcome };
    }),

    // §6 step 5: the terminal status, aggregated here from the recorded
    // outcomes (never taken from the worker), and the result when available.
    // Create-once: a finished command never finishes again.
    finish: ({ commandId, generation, result = null }) => owned(commandId, generation, async (tx, command) => {
      if (command.status !== "pending") throw new CommandRefused("command-finished");
      if (result !== null) requirePayload(result);
      const occurrences = await tx.list(["commands", commandId, "occurrences"]);
      const outcomes = new Map<string, { outcome: string }>((await tx.list(["commands", commandId, "outcomes"])).map(o => [docKey(o.stage, o.occurrenceId), o]));
      // A refused bind is a failed operation: nothing was written for it, and
      // the command didn't do what its program asked (C6 slice 0).
      const refusals = await tx.list(["commands", commandId, "refusals"]);
      // A repair settles the ledger entries it holds (B6 decision 4).
      const repair = command.kind === "repair";
      const held = repair ? (await tx.list(["commands", command.repairOf, "ledger"])).filter(e => e.status === "pending" && e.repairId === commandId) : [];
      const operations = [
        ...occurrences.map(o => ({ outcome: outcomes.get(docKey(o.stage, o.occurrenceId))?.outcome ?? null })),
        ...refusals.map(() => ({ outcome: "failed" })),
      ];
      // An occurrence still waiting to settle keeps the command pending (§7).
      if (operations.some(o => o.outcome === null)) throw new CommandRefused("occurrences-unsettled");
      // A stage is done when its answer closed it, or — for a stage whose
      // intents are all static, closed at admission — when every admitted
      // occurrence has an outcome, so a revoked connection can't keep a fully
      // settled stage open (§4, §7).
      // A repair runs only some stages: the ones it touched decide.
      const boundStages = new Set(occurrences.map(o => o.stage));
      const stages = Object.entries(command.admission?.stages ?? {}).filter(([name]) => !repair || stageOf(command, name).state !== "pending" || boundStages.has(name)).map(([name, s]) => {
        const intents = (s as { intents?: { id: string, runtime?: boolean, occurrences?: string[] }[] }).intents ?? [];
        const own = stageOf(command, name);
        const allStatic = intents.length > 0 && intents.every(i => !i.runtime);
        const settled = allStatic && intents.every(i => (i.occurrences ?? []).every(occ => outcomes.has(docKey(name, occ))));
        return { ...own, ...(settled ? { state: "ran", expansion: "closed" } : {}), hasIntents: intents.length > 0 };
      });
      const status = aggregateStatus({ operations, stages });
      const counts = { ...command.counts, completed: 0, failed: 0, partial: 0, uncertain: 0 };
      for (const o of operations) counts[o.outcome]++;
      const available = result !== null;
      const digest = available ? sha256(result) : null;
      if (available) tx.set(sub(commandId, "result", "final"), { text: result, digest });
      const refusedKeys = new Set(refusals.map(r => docKey(r.stage, r.occurrenceId)));
      for (const entry of held) {
        const k = docKey(entry.stage, entry.occurrenceId);
        const outcome = outcomes.get(k) as { outcome: string, source?: string, receipt?: string, output?: unknown } | undefined;
        // Not bound, or refused at bind: nothing was written for it.
        const status = outcome?.outcome ?? "failed";
        const source = outcome ? outcome.source : refusedKeys.has(k) ? "bind-refusal" : "not-reached";
        tx.set(sub(command.repairOf, "ledger", k), { ...entry, status, source, receipt: outcome?.receipt ?? null, output: outcome?.output ?? null, settledAt: at(), generation });
      }
      // A repair publishes the original's artifact once the original is
      // complete (decision 8, slice 4), never its own.
      const publish = status === "completed" && available && !repair;
      return touch(tx, command, {
        status,
        counts,
        result: { state: available ? "available" : "unavailable", digest },
        publication: publish ? { state: "due", resultDigest: digest } : { state: "none", resultDigest: null },
      });
    }),

    // §6 step 6: the publication delivered.
    published: ({ commandId, generation }) => owned(commandId, generation, async (tx, command) => {
      if (command.publication?.state === "published") return command;
      if (command.publication?.state !== "due") throw new CommandRefused("nothing-to-publish");
      return touch(tx, command, { publication: { ...command.publication, state: "published" } });
    }),

    // B6 (decisions 4 and 11): a repair's admission, with the claim of every
    // occurrence it selected, in one transaction. Each must be `failed` now
    // and held by no other repair; otherwise nothing is claimed. A retry by
    // the same repair is acknowledged. `admission` is the original's,
    // referenced: the same plan, models, revisions, intents and bounds.
    claimRepair: ({ commandId, generation, admission }) => owned(commandId, generation, async (tx, command) => {
      if (command.kind !== "repair") throw new CommandRefused("kind-mismatch");
      if (command.phase === "admitted") return command;
      const original = await tx.get(cmdPath(command.repairOf));
      const gate = repairGate(original, command.selection ?? []);
      if (gate) throw new CommandRefused(gate);
      const states = await occurrenceStates(tx, command.repairOf);
      const claims = [];
      for (const { stage, occurrenceId } of command.selection ?? []) {
        const st = states.get(docKey(stage, occurrenceId));
        if (st?.heldBy === commandId) continue;
        if (st?.heldBy) throw new CommandRefused("occurrence-claimed", { stage, occurrenceId, repairId: st.heldBy });
        if (st?.current !== "failed") throw new CommandRefused("not-eligible", { stage, occurrenceId });
        claims.push(st);
      }
      for (const st of claims) {
        const prior = st.entry;
        tx.set(sub(command.repairOf, "ledger", docKey(st.stage, st.occurrenceId)), {
          stage: st.stage,
          occurrenceId: st.occurrenceId,
          commandId: command.repairOf,
          status: "pending",
          prior: st.current,
          repairId: commandId,
          claim: "admission",
          claimedAt: at(),
          generation,
          argsDigest: prior?.argsDigest ?? null,
          counted: prior?.counted ?? false,
          attempts: prior ? [...(prior.attempts ?? []), { repairId: prior.repairId, status: prior.status, source: prior.source ?? null }] : [],
        });
      }
      const stages = Object.fromEntries(Object.keys(admission.stages).map(name => [name, { ...stageOf(command, name) }]));
      return touch(tx, command, { phase: "admitted", admission, stages, revisions: admission.revisions ?? null });
    }),

    // B6 (decision 2): an applied, final reconciliation verdict for one of a
    // command's operations (`commandId` is the command whose invocation it
    // ran under). An uncertain occurrence becomes `completed` in the ledger,
    // with its output, or `unavailable` when it can't be established (and
    // `conflict`, a bug, blocks it alike). Bookkeeping, not an owner write:
    // it records what the provider shows, and never a `failed`.
    recordReconciliation: ({ commandId, stage, occurrenceId, operationId, result = null, resultSource = null }) => backend.transaction(async tx => {
      requireStage(stage);
      const command = await tx.get(cmdPath(commandId));
      if (!command) throw new CommandRefused("command-not-found");
      const repair = command.kind === "repair";
      const originalId = repair ? command.repairOf : commandId;
      const k = docKey(stage, occurrenceId);
      const path = sub(originalId, "ledger", k);
      const entry = await tx.get(path);
      const outcome = repair ? null : await tx.get(sub(commandId, "outcomes", k));
      // The original's own uncertain write, or the uncertain one a repair
      // settled; nothing else is reconciled into the ledger.
      const applies = repair ? entry?.repairId === commandId && entry.status === "uncertain" : !entry && outcome?.outcome === "uncertain";
      if (!applies) return { recorded: false, status: entry?.status ?? outcome?.outcome ?? null };
      const established = (resultSource === "outcome" || resultSource === "evidence") && result !== null && result !== undefined;
      const output = established ? (outputOf(result).output ?? null) : { unavailable: resultSource ?? "unavailable" };
      const next = {
        ...(entry ?? { stage, occurrenceId, commandId: originalId, repairId: null, attempts: [] }),
        status: "completed",
        source: "reconciliation",
        receipt: operationId,
        output,
        settledAt: at(),
      };
      tx.set(path, next);
      return { recorded: true, status: "completed", output };
    }),

    // An original's occurrences and their current outcomes, for a repair's
    // selection (no fence; the claim re-checks in its transaction).
    async repairState(originalId) {
      return backend.transaction(async tx => {
        const original = await tx.get(cmdPath(originalId));
        if (!original) return { original: null, occurrences: [] };
        const states = await occurrenceStates(tx, originalId);
        return { original, occurrences: [...states.values()].map(({ stage, occurrenceId, current, heldBy }) => ({ stage, occurrenceId, current, heldBy })) };
      });
    },
    async listLedger(originalId) {
      return backend.transaction(tx => tx.list(["commands", originalId, "ledger"]));
    },

    // Reads, for Policy and the worker's recovery (no fence).
    async getResult(commandId) {
      return backend.transaction(tx => tx.get(sub(commandId, "result", "final")));
    },
    async getModels(commandId) {
      return backend.transaction(tx => tx.list(["commands", commandId, "models"]));
    },
    async getInput(commandId, stage) {
      return backend.transaction(tx => tx.get(sub(commandId, "inputs", stage)));
    },
    async getOutput(commandId, stage) {
      return backend.transaction(tx => tx.get(sub(commandId, "outputs", stage)));
    },
    async getOccurrence(commandId, stage, occurrenceId) {
      return backend.transaction(tx => tx.get(sub(commandId, "occurrences", docKey(stage, occurrenceId))));
    },
    async listOccurrences(commandId) {
      return backend.transaction(tx => tx.list(["commands", commandId, "occurrences"]));
    },
    async listRefusals(commandId) {
      return backend.transaction(tx => tx.list(["commands", commandId, "refusals"]));
    },
    async listOutcomes(commandId) {
      return backend.transaction(tx => tx.list(["commands", commandId, "outcomes"]));
    },
  };
};

export { DIGEST_RE };

// The memory backend: the command documents are the memory command store's
// (commands.js), so allocation, leases and records share one state, as
// Policy's database does. A transaction runs alone, buffers its writes and
// commits them only if it returns, so a refused write changes nothing.
export const createMemoryCommandBackend = ({ commandStore }) => {
  const docs = new Map();
  let queue = Promise.resolve();
  const key = path => path.join("/");
  const read = path => {
    if (path.length === 2) return commandStore.commands.get(path[1]) ?? null;
    return docs.get(key(path)) ?? null;
  };
  return {
    docs,
    transaction(fn) {
      const run = queue.then(async () => {
        const writes = new Map();
        const tx = {
          get: async path => structuredClone(writes.has(key(path)) ? writes.get(key(path)).doc : read(path)),
          set: (path, doc) => writes.set(key(path), { path, doc: structuredClone(doc) }),
          list: async path => {
            const prefix = `${key(path)}/`;
            return [...docs.entries()].filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map(([, d]) => structuredClone(d));
          },
        };
        const out = await fn(tx);
        for (const { path, doc } of writes.values()) {
          if (path.length === 2) commandStore.commands.set(path[1], doc);
          else docs.set(key(path), doc);
        }
        return out;
      });
      queue = run.catch(() => {});
      return run;
    },
  };
};
