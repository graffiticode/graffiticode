// A continuation driver over protocol.mjs: it runs one child continuation
// through C0 to C5, resuming from whatever has committed, and runs a
// multi-item claim whose source set and child ids are fixed once
// (respondent-sessions proposal §4.4). `crashAfter` names the step after
// whose commit the driver "crashes" (throws), so tests can resume or cancel
// from every point. Cross-store evidence is fetched by reading the other
// store between transactions, as the real services would over an
// authenticated call.

import { FieldPath } from "@google-cloud/firestore";
import {
  ProtocolError,
  activate,
  ackFinalized,
  allocate,
  bindPrepare,
  cancelApi,
  cancelConsole,
  finalize,
  readOp,
  register,
  samePrincipal,
  unlock,
} from "./protocol.mjs";

export const STEPS = ["C0", "C1", "C2", "C3", "C3a", "C4", "C5"];

export class Crash extends Error {
  constructor(step) {
    super(`crash after ${step}`);
    this.step = step;
  }
}

// Runs (or resumes) one child continuation. Every step is idempotent, so a
// resume simply runs them all again in order.
export async function runChild({ api, console: con }, request, { crashAfter } = {}) {
  const after = step => {
    if (crashAfter === step) throw new Crash(step);
  };
  const reg = await register(api, request);
  after("C0");
  const cop = await allocate(con, reg);
  after("C1");
  const prepared = await bindPrepare(api, request.opId);
  after("C2");
  await finalize(con, prepared);
  after("C3");
  await ackFinalized(api, { opId: request.opId, revision: cop.revision, T: reg.T, X: request.source });
  after("C3a");
  const result = await activate(api, request.opId);
  after("C4");
  await unlock(con, await readOp(api, request.opId));
  after("C5");
  return { ...result, opId: request.opId, T: reg.T };
}

// Cancels a child: the api half (which loses to a committed C4), then the
// console half with the api's terminal evidence.
export async function cancelChild({ api, console: con }, opId) {
  await cancelApi(api, opId);
  return cancelConsole(con, await readOp(api, opId));
}

// A multi-item claim. The parent record fixes the source set and the stable
// child operation ids once; a retry resumes that same set, reuses completed
// children, and never discovers newly added sources or mints different ids.
// The parent also binds the claim's caller and destination principal at
// creation: a replay naming a different caller or destination is refused.
export async function startClaim({ console: con }, { claimId, sources, caller, destPrincipal }) {
  const ref = con.doc("claims", claimId);
  return con.run(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const claim = snap.data();
      if (!samePrincipal(claim.caller, caller) || !samePrincipal(claim.destPrincipal, destPrincipal)) {
        throw new ProtocolError("claim-mismatch");
      }
      return claim;
    }
    const claim = {
      claimId,
      caller,
      destPrincipal,
      children: sources.map(s => ({ ...s, opId: `${claimId}:${s.source}` })),
      outcomes: {},
    };
    tx.create(ref, claim);
    return claim;
  });
}

// Records one child's terminal outcome on the parent, once.
async function recordOutcome(con, claimId, opId, outcome) {
  const ref = con.doc("claims", claimId);
  return con.run(async tx => {
    const claim = (await tx.get(ref)).data();
    if (claim.outcomes?.[opId]) return claim.outcomes[opId];
    tx.update(ref, new FieldPath("outcomes", opId), outcome);
    return outcome;
  });
}

// Runs every child of a claim with the caller and destination bound at its
// creation. A child refused permanently (it can't prove authority over its
// session, its source changed, ...) is cancelled, and its refusal recorded on
// the parent, so the other children still proceed; a replay returns the
// recorded refusal and never retries that child. Temporary refusals and
// crashes propagate, so the claim can be resumed.
export async function runClaim(stores, claim, { crash = {} } = {}) {
  const results = [];
  for (const child of claim.children) {
    const recorded = (await stores.console.doc("claims", claim.claimId).get()).data().outcomes?.[child.opId];
    if (recorded?.refused) {
      results.push({ opId: child.opId, refused: recorded.refused });
      continue;
    }
    const request = {
      opId: child.opId,
      session: child.session,
      source: child.source,
      sourceVersion: child.sourceVersion,
      expectedRevision: child.expectedRevision,
      caller: claim.caller,
      destPrincipal: claim.destPrincipal,
    };
    try {
      results.push(await runChild(stores, request, { crashAfter: crash[child.opId] }));
    } catch (err) {
      if (!(err instanceof ProtocolError) || err.temporary) throw err;
      const op = await readOp(stores.api, child.opId);
      if (op && op.state !== "completed") await cancelChild(stores, child.opId);
      if (op?.state === "completed") throw err; // past the point of no return: roll forward instead
      await recordOutcome(stores.console, claim.claimId, child.opId, { refused: err.code });
      results.push({ opId: child.opId, refused: err.code });
    }
  }
  return results;
}

export const isProtocolError = (err, code) => err instanceof ProtocolError && (!code || err.code === code);
