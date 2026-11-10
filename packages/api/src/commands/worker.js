// The command worker (B5, docs/b5-commands-plan.md §6–§7): runs one command
// that this worker owns, from wherever its record says it is, to its terminal
// outcome and publication. A fresh command and a taken-over one run the same
// code: every step is install-once or recorded in Policy, so a resumed run
// reuses the request, models, revisions, pinned inputs and occurrences the
// first run recorded, and the Broker replays any write that already ran.
//
//   run({ commandId, generation }) -> the command's state when the run stops
//
// The run stops early, leaving the command pending, when this worker loses the
// command: a lease renewal is refused, or any Policy write answers
// stale-generation or lease-expired. Whoever holds it now continues.

import { createHash } from "node:crypto";
import { decodeChainId } from "@graffiticode/common/chain";
import { canonicalDigest } from "@graffiticode/common/canonical";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import { PolicyRefused } from "./policy-commands.js";
import { ARTIFACT_RESULT_FORM } from "../read.js";

export const LEASE_RENEW_MS = 20_000;
const LOST_OWNERSHIP = new Set(["stale-generation", "lease-expired", "command-finished"]);
const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");

// A stage's answer was lost and the stage can be asked again (it has no
// effects, or its runtime expansion is still open and its bound occurrences
// replay): the command stays pending, and recovery continues it.
export class ResumeLater extends Error {
  constructor(message) {
    super(message);
    this.name = "ResumeLater";
  }
}

export class OwnershipLost extends Error {
  constructor(reason) {
    super(`this worker no longer owns the command (${reason})`);
    this.reason = reason;
  }
}

// What a stage passes on: its data in the envelope a compile receives.
const envelopeOf = answer => ({ data: answer?.data ?? null, errors: [] });
const failed = answer => Boolean(answer?.responseLost) || (Array.isArray(answer?.errors) && answer.errors.length > 0);

// `policy`: buildPolicyCommands (or an in-process equivalent in tests).
// `language`: { model, preflight, interpret, start, baseUrlFor } for the
// stages' services. `artifactStorer`: storage/artifacts.js.
export const buildCommandWorker = ({
  policy, taskStorer, language, artifactStorer, worker, renewEveryMs = LEASE_RENEW_MS, faults = null,
  setInterval: every = setInterval, clearInterval: stopEvery = clearInterval,
  log = line => console.log(line),
}) => async ({ commandId, generation }) => {
  let lost = null;
  const owned = async step => {
    if (lost) throw new OwnershipLost(lost);
    try {
      return await step();
    } catch (e) {
      if (e instanceof PolicyRefused && LOST_OWNERSHIP.has(e.reason)) {
        lost = e.reason;
        throw new OwnershipLost(e.reason);
      }
      throw e;
    }
  };
  // The lease is renewed on its own timer: a stage may run for minutes.
  const renewal = every(() => {
    policy.lease({ commandId, worker, generation }).catch(e => {
      lost = lost ?? (e?.reason ?? "renewal-failed");
      log(`WARN command ${commandId}: lease not renewed (${lost})`);
    });
  }, renewEveryMs);
  renewal?.unref?.();
  const ids = { commandId, generation };
  try {
    let state = await owned(() => policy.read({ commandId, what: "state" }));
    if (state.status === "pending") {
      if (state.phase !== "admitted") {
        const admitted = await initialize({ state, ids, owned });
        if (!admitted) {
          state = await owned(() => policy.finish({ ...ids }));
          return state;
        }
        state = await owned(() => policy.read({ commandId, what: "state" }));
      }
      const result = await runStages({ state, ids, owned });
      await owned(() => policy.finish({ ...ids, result }));
      state = await owned(() => policy.read({ commandId, what: "state" }));
    }
    if (state.publication?.state === "due") {
      await publish({ state, ids, owned });
      state = await owned(() => policy.read({ commandId, what: "state" }));
    }
    return state;
  } catch (e) {
    if (e instanceof OwnershipLost) {
      log(`WARN command ${commandId}: stopped, ${e.message}`);
      return { commandId, status: "pending", lost: e.reason };
    }
    if (e instanceof ResumeLater) {
      log(`WARN command ${commandId}: left pending for recovery, ${e.message}`);
      return { commandId, status: "pending", resume: true };
    }
    throw e;
  } finally {
    stopEvery(renewal);
  }

  // §6 step 2, resumable until admission commits: each stage's model is
  // installed once (a resumed run reuses those already there), every stage is
  // preflighted, and the chain is admitted under the command's principal.
  // Returns false when the command can't be admitted: nothing ran.
  async function initialize({ state, ids: { commandId: id, generation: g }, owned: step }) {
    const tasks = await taskStorer.get({ id: state.taskId, auth: { uid: state.uid } });
    const taskIds = decodeChainId(state.taskId);
    const { models } = await step(() => policy.read({ commandId: id, what: "models" }));
    const installed = new Set(models.map(m => m.stage));
    const manifests = [];
    for (const [index, task] of tasks.entries()) {
      const stage = `s${index}`;
      const baseUrl = await language.baseUrlFor(task.lang);
      if (!installed.has(stage)) {
        const out = await language.model({ lang: task.lang, code: task.code, baseUrl });
        // No answer: try again later (the command stays pending, and recovery
        // continues it). A compile error is the program's: nothing runs.
        if (out?.responseLost) throw new Error(`command ${id}: ${stage}'s model got no answer`);
        if (!out?.model || failed(out)) {
          log(`WARN command ${id}: ${stage} has no model; nothing runs`);
          return false;
        }
        await step(() => policy.installModel({ commandId: id, generation: g, stage, text: JSON.stringify(out.model), revision: out.revision ?? null }));
      }
      const out = await language.preflight({ baseUrl, lang: task.lang, stage, code: task.code });
      const manifest = out?.manifest;
      if (!manifest || manifest.stage !== stage || manifest.sourceDigest !== canonicalDigest(task.code)) {
        log(`WARN command ${id}: ${stage} preflight didn't match the stored task; nothing runs`);
        return false;
      }
      manifests.push(manifest);
    }
    try {
      await step(() => policy.admit({ commandId: id, generation: g, taskIds, stages: manifests }));
    } catch (e) {
      if (e instanceof OwnershipLost) throw e;
      // A definite refusal (no longer permitted, a revision retired): nothing
      // ran, and the command finishes failed.
      if (e instanceof PolicyRefused) {
        log(`WARN command ${id}: not admitted (${e.reason})`);
        return false;
      }
      throw e;
    }
    return true;
  }

  // §6 steps 3–4: the stages right to left, each from its admitted model at its
  // pinned revision. A stage with intents is pinned, then started under its
  // session; its occurrences are closed and settled from receipts. The chain
  // stops at a stage that failed or lost its answer; the stages left of it are
  // not reached. Returns the head's result text, or null when there is none.
  async function runStages({ state, ids: { commandId: id, generation: g }, owned: step }) {
    const { models } = await step(() => policy.read({ commandId: id, what: "models" }));
    const modelOf = new Map(models.map(m => [m.stage, JSON.parse(m.text)]));
    const stages = Object.keys(state.admission.stages).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
    let input = { data: {}, errors: [] };
    for (const [position, stage] of stages.entries()) {
      const admitted = state.admission.stages[stage];
      const model = modelOf.get(stage);
      const notReached = stages.slice(position + 1);
      const stop = async () => {
        if (notReached.length) await step(() => policy.notReached({ commandId: id, generation: g, stages: notReached }));
        return null;
      };
      if (!admitted.intents.length) {
        const answer = await language.interpret({ lang: admitted.lang, model, input, mode: "evaluate", baseUrl: admitted.tagUrl });
        // A stage with no effects is safe to ask again: a lost answer leaves
        // the command pending for recovery, never failed.
        if (answer?.responseLost) throw new ResumeLater(`${stage} got no answer`);
        if (failed(answer)) return stop();
        input = envelopeOf(answer);
        continue;
      }
      // The input is pinned before the first effect, once: a resumed run
      // starts from the input the first run pinned, never a new one.
      const pinned = await step(() => policy.installInput({ commandId: id, generation: g, stage, text: JSON.stringify(input) }));
      let sessionToken;
      try {
        ({ sessionToken } = await step(() => policy.session({ commandId: id, generation: g, stage })));
      } catch (e) {
        if (e instanceof OwnershipLost || !(e instanceof PolicyRefused)) throw e;
        // The stage can't run any more (the connection was revoked, a pinned
        // revision retired): record what already happened, from receipts, and
        // stop. Revocation never changes what already ran (§7).
        log(`WARN command ${id}: ${stage} can't run (${e.reason})`);
        await step(() => policy.settle({ commandId: id, generation: g }));
        return stop();
      }
      let answer = await language.start({ lang: admitted.lang, model, input: JSON.parse(pinned.text), commandSession: sessionToken, stage, baseUrl: admitted.tagUrl });
      // The drive's faults (faults.js), never set in production: the writes
      // have run, and the worker dies, or the head's answer is lost.
      if (faults?.appliesTo(state.uid) && !answer?.responseLost) {
        if (faults.exitAfterWrite) {
          log(`WARN command ${id}: fault exit-after-write`);
          faults.exit();
          throw new Error(`command ${id}: the worker's process exited (fault)`);
        }
        if (faults.loseHeadAnswer && position === stages.length - 1) {
          log(`WARN command ${id}: fault lose-head-answer`);
          answer = { responseLost: true };
        }
      }
      if (answer?.responseLost) {
        await step(() => policy.settle({ commandId: id, generation: g }));
        // A runtime expansion closes only from the stage's own answer, so an
        // open one can't be settled done (B5 fix G): it is resumed instead.
        // Recovery re-runs start on the pinned input; the occurrences already
        // bound present their recorded ids and the Broker replays them with no
        // provider call, and the expansion continues and closes.
        if (admitted.intents.some(i => i.runtime)) throw new ResumeLater(`${stage}'s answer was lost with its expansion open`);
        await step(() => policy.lost({ commandId: id, generation: g, stage }));
        return stop();
      }
      if (answer?.occurrences) await step(() => policy.closeStage({ commandId: id, generation: g, stage, occurrences: answer.occurrences }));
      await step(() => policy.settle({ commandId: id, generation: g }));
      if (failed(answer)) return stop();
      input = envelopeOf(answer);
    }
    // The head's own answer is the result; receipts are never a substitute.
    return JSON.stringify(input.data);
  }

  // §6 step 6: the artifact, delivered from the result finish committed. Only
  // that content is delivered (a duplicate is acknowledged by the store), so a
  // late or stale delivery can't put anything else there.
  async function publish({ state, ids: { commandId: id, generation: g }, owned: step }) {
    const { result } = await step(() => policy.read({ commandId: id, what: "result" }));
    if (!result || sha256(result.text) !== state.publication.resultDigest) throw new Error(`command ${id}: the committed result can't be read`);
    await artifactStorer.put({
      uid: state.uid,
      ownerUid: state.ownerUid,
      connectionId: state.connectionId,
      taskId: state.taskId,
      invocationId: state.invocationId,
      seq: state.seq,
      registryVersion: REGISTRY_VERSION,
      // The head's output, not a compile envelope: the read path serves it
      // as one (read.js storedEnvelope). The mark isn't a binding, so a
      // repeated delivery of an artifact stored before it still acknowledges.
      form: ARTIFACT_RESULT_FORM,
      content: JSON.parse(result.text),
    });
    await step(() => policy.published({ commandId: id, generation: g }));
  }
};
