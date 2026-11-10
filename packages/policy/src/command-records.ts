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
    installInput: ({ commandId, generation, stage, text }) => owned(commandId, generation, async (tx, command) => {
      requireStage(stage);
      requirePayload(text);
      if (command.phase !== "admitted") throw new CommandRefused("not-admitted");
      const { installed, created } = await installOnce(tx, sub(commandId, "inputs", stage), { stage, text, digest: sha256(text) });
      if (created) {
        const stages = { ...command.stages, [stage]: { ...stageOf(command, stage), pinnedInput: installed.digest } };
        touch(tx, command, { stages });
      }
      return { stage, digest: installed.digest, text: installed.text };
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
        pending.push({ path, outcome: { stage, occurrenceId, outcome: outcomeFromReceipt(op.status), source: "receipt", receipt: op.operationId, final: op.recorded === true, reason: op.reason ?? null, steps, at: new Date(now()).toISOString(), generation } });
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
      const stages = Object.entries(command.admission?.stages ?? {}).map(([name, s]) => {
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
      const publish = status === "completed" && available;
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
