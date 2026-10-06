// The broker's single entry point: execute one named operation under one
// policy-issued execution token.
//
//   1. The token must verify as an EXECUTION token (fixed alg, issuer,
//      audience, typ, expiry) and name exactly this operation.
//   2. The token's registry version must be the one installed here, and the
//      registry must still allow (lang, fn, op, backend) — checked
//      again here so correctness never rests on policy alone.
//   3. The payload must pass the operation's constraints and hash to the
//      token's args digest: the token authorizes this request, not any.
//   4. The token's jti is claimed once (replay).
//   5. A WRITE claims its operation receipt atomically before the provider
//      call. A second token for the same operation — a retry — gets the
//      recorded outcome, or "uncertain" if the first attempt never finished;
//      it never executes again. Reusing an operation id with a different
//      principal, connection, function or args is refused. Only a definite
//      provider rejection records failed/partial; any other provider error
//      records uncertain, since the write may have been applied.
//   6. Each completed provider step is persisted before the next provider
//      request starts (spec WRITE-01). If it cannot be, the operation stops
//      there and records uncertain (best effort); a retry finds the claim and
//      never re-executes. A replay with no final outcome reports uncertain
//      with the steps that were persisted.
//   7. Immediately before each effect (each provider request, each local
//      signature, each receipt replay) Broker asks Policy's
//      authorize-execution whether that one step is still authorized (spec
//      EXEC-02, API-02; authorizer.js). The step and its purpose come from
//      the registered step table, in order; a decision is never cached or
//      reused. Denied or unavailable, the effect doesn't happen: a refusal
//      before the receipt claim; after it, `failed` with no step taken or
//      `partial` after one, with the reason recorded. A token that can't
//      outlast the deadline is refused on arrival (`token-expiring`), before
//      it is spent, so the caller can retry with a fresh one.
//
// Time limits (limits.js): each provider request has a timeout, and no request
// starts after the operation's deadline. A request that times out is
// uncertain; one never started because of the deadline is definite (failed,
// or partial after earlier steps). The deadline is measured from the request's
// arrival, so slow preparation (token checks, receipt claim) cannot push a
// provider request past it. A write registers in `activity` under its own
// attempt key right after admission, and leaves when that attempt finishes,
// so an operator can wait for active writes to drain.
//
// While protected execution is switched off, every execution is refused with
// `maintenance` (503) right after the token and caller check, except the
// configured canary's (its token's principal and connection), audited as such.
//
// Every decision is audited (pseudonymous ids; no tokens, secrets or bodies).

import { randomUUID } from "node:crypto";
import { gatedOperations, isOperationAllowed, isStepRegistered, REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import { verifyToken, provenanceRefusal, MAINTENANCE, admission } from "@graffiticode/policy";
import { argsDigest } from "./canonical.js";
import { DeadlineExceeded, PayloadRejected, ProviderRejected } from "./operations.js";
import { DEFAULT_LIMITS, headroomMs, maxExecutionMs } from "./limits.js";
import { AuthorizationDenied, AuthorizationUnavailable } from "./authorizer.js";

// Broker asked for a step its own operation definition doesn't register, or
// out of order: a bug here, never a request field. No effect follows.
class StepNotRegistered extends Error {}

// Why an authorization didn't lead to the effect, for refusals and outcomes.
const authorizationReason = e => {
  if (e instanceof AuthorizationDenied) return `authorization-denied:${e.reason}`;
  if (e instanceof AuthorizationUnavailable) return "authorization-unavailable";
  if (e instanceof DeadlineExceeded) return "deadline-exceeded";
  if (e instanceof StepNotRegistered) return "step-not-registered";
  return null;
};

// A provider step completed but could not be persisted; the operation must
// not take its next step.
class StepNotPersisted extends Error {
  declare step: string;
  constructor(step: string, cause: any) {
    super(`step ${step} completed but could not be recorded: ${String(cause?.message || cause)}`);
    this.step = step;
  }
}

export class BrokerRefused extends Error {
  declare reason: string;
  declare status: number;
  declare detail: unknown;
  constructor(reason: string, status = 403, detail?: unknown) {
    super(`broker refused: ${reason}`);
    this.reason = reason;
    this.status = status;
    this.detail = detail;
  }
}

// A receipt is bound to everything that authorized its write. A replay must
// match all of it; one recorded under another registry version is refused
// rather than reinterpreted.
const BINDING_FIELDS = ["principal", "ownerUid", "connectionId", "lang", "fn", "op", "registryVersion", "argsDigest"];
const sameBinding = (a, b) => BINDING_FIELDS.every(f => a[f] === b[f]);

export const createBroker = ({ jwks, operations, secrets, once, receipts, activity, protectedSwitch, authorize, limits = DEFAULT_LIMITS, now = Date.now, audit }) => {
  // No default: a broker built without the switch would run ungated.
  if (!protectedSwitch || typeof protectedSwitch.state !== "function") throw new Error("createBroker needs a protectedSwitch");
  // Nor without Policy's live authorization (authorizer.js): it would act on
  // a token's authority however much had been revoked since it was minted.
  if (typeof authorize !== "function") throw new Error("createBroker needs an authorize function");
  // Every limit, as parseLimits produces them: a missing one would turn into
  // a zero wait (setTimeout reads NaN as 0) and race every authorization.
  for (const name of ["providerCallMs", "executionMs", "authorizeMs"]) {
    if (!(Number.isInteger(limits?.[name]) && limits[name] > 0)) throw new Error(`createBroker needs limits.${name} (see limits.js)`);
  }
  // Nor without activity tracking, which draining relies on.
  if (!activity || typeof activity.begin !== "function") throw new Error("createBroker needs an activity store");
  // Wait for one decision, at most `waitMs`. The timer aborts pending work;
  // it doesn't decide lateness, since a busy event loop can run it after a
  // decision that already took too long. The cutoff does: a decision that
  // resolves after it is discarded.
  const decide = async (ask, waitMs) => {
    const cutoff = now() + waitMs;
    const controller = new AbortController();
    let timer;
    const late = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AuthorizationUnavailable(`no authorization within ${waitMs} ms`));
      }, waitMs);
    });
    let decision;
    try {
      decision = await Promise.race([authorize({ ...ask, signal: controller.signal }), late]);
    } finally {
      clearTimeout(timer);
    }
    if (now() > cutoff) throw new AuthorizationUnavailable(`authorization arrived after ${waitMs} ms`);
    return decision;
  };

  const execute = async ({ caller, token, op, payload }) => {
    // The execution's one clock, started when the request arrives, before any
    // asynchronous work, so the deadline and the activity entry's expiry share
    // an origin. No effect starts later than the deadline, however slow the
    // preparation or the authorizations were.
    const startedAt = now();
    const deadline = startedAt + limits.executionMs;
    let claims;
    try {
      ({ claims } = await verifyToken(jwks, "execution", token));
    } catch {
      await audit({ event: "execute", op, outcome: "denied", reason: "bad-token" });
      throw new BrokerRefused("bad-token", 401);
    }
    const record = {
      event: "execute",
      uid: claims.sub,
      ownerUid: claims.own,
      connectionId: claims.conn,
      lang: claims.lang,
      fn: claims.fn,
      op,
      registryVersion: claims.rv,
    };
    const refuse = async (reason: string, status?: number, detail?: unknown) => {
      await audit({ ...record, outcome: "denied", reason });
      throw new BrokerRefused(reason, status, detail);
    };

    // Only the compiler of the token's language may spend it.
    if (caller?.role !== "compiler" || caller.lang !== claims.lang) return refuse("caller-language-mismatch");
    // The authority it rests on (Policy's provenance.js), checked here too.
    const badProvenance = provenanceRefusal(claims);
    if (badProvenance) return refuse(badProvenance);
    // Protected execution switched off (@graffiticode/policy maintenance.js):
    // refused before anything stateful, so the token is not spent and a retry
    // within its lifetime can still run once execution is back on.
    // While paused, the canary still runs: matched on the verified token's
    // principal and connection, never on request fields.
    const admitted = admission(await protectedSwitch.state(), { uid: claims.sub, connectionId: claims.conn });
    if (!admitted) return refuse(MAINTENANCE, 503);
    if (admitted === "canary") await audit({ ...record, outcome: "allowed", reason: "canary-during-maintenance" });
    // The token is presented at every authorization up to the deadline, so it
    // must outlast it (limits.js headroomMs). Refused before it is spent or
    // any receipt is claimed: the caller retries with a fresh token for the
    // same operation.
    if (claims.exp * 1000 - now() < headroomMs(limits)) return refuse("token-expiring", 409);

    // Policy's decision for one step, immediately before its effect. The
    // wait never passes the deadline; after the decision, the deadline and
    // the token's expiry are checked again, so a late or stale decision
    // can't authorize anything. Dispatch steps go in registered order.
    // Immediately before an effect: the deadline, and the token itself.
    const inTime = what => {
      if (now() >= deadline) throw new DeadlineExceeded(`operation deadline of ${limits.executionMs} ms passed before ${what}`);
      if (now() >= claims.exp * 1000) throw new AuthorizationDenied("token-expired");
    };
    let lastDispatch = null;
    const authorizeStep = async (step, purpose) => {
      const after = purpose === "dispatch" ? lastDispatch : null;
      if (!isStepRegistered({ op, step, purpose, after })) throw new StepNotRegistered(`${op} has no ${purpose} step ${step} after ${after}`);
      const waitMs = Math.min(limits.authorizeMs, deadline - now());
      if (waitMs <= 0) throw new DeadlineExceeded(`operation deadline of ${limits.executionMs} ms passed before authorizing ${step}`);
      const { decisionId } = await decide({ executionToken: token, op, argsDigest: claims.argd, step, purpose, after }, waitMs);
      // Policy's decision, audited before the final checks: nothing awaited
      // may come between them and the effect. A step stopped by those checks
      // is reported in the operation's own outcome.
      await audit({ ...record, event: "execute-step", jti: claims.jti, opid: claims.opid, step, purpose, decisionId, outcome: "allowed" });
      inTime(step);
      if (purpose === "dispatch") lastDispatch = step;
      return decisionId;
    };
    // Called by the operation just before each provider request: authorizes
    // it, then returns its timeout.
    const providerCall = async step => {
      await authorizeStep(step, "dispatch");
      // Never a zero or negative timeout: a request with no time left is not
      // sent, which is definite (failed, or partial after earlier steps).
      const remaining = deadline - now();
      if (remaining <= 0) throw new DeadlineExceeded(`operation deadline of ${limits.executionMs} ms passed before ${step} was sent`);
      return Math.min(limits.providerCallMs, remaining);
    };

    // A write registers as active right after admission, before anything else
    // asynchronous, and under its own attempt key: a second request for the
    // same operation (a retry that replays the receipt) has its own entry and
    // never removes this one. The entry expires when this attempt's last
    // possible provider request has ended (startedAt + maxExecutionMs). A
    // failure to register propagates before any claim or provider request.
    const operation = Object.prototype.hasOwnProperty.call(operations, op) ? operations[op] : null;
    if (operation?.kind !== "write") {
      return executeAdmitted({ claims, op, operation, payload, record, refuse, providerCall, authorizeStep, inTime });
    }
    const attempt = `${claims.opid}#${randomUUID()}`;
    await activity.begin(attempt, startedAt + maxExecutionMs(limits));
    try {
      // The drain barrier: having registered, read the switch again, past its
      // cache. `drain` reads the flag as off and only then counts active
      // writes. If this registration landed before that count, the count sees
      // it and drain waits. If it landed after, this read comes later still
      // than the flip, sees off, and refuses before any provider request. So
      // an empty count means no write can still dispatch, however slow
      // registration was. (The canary is still admitted; do not run it while
      // draining.)
      if (!admission(await protectedSwitch.state({ fresh: true }), { uid: claims.sub, connectionId: claims.conn })) {
        return await refuse(MAINTENANCE, 503);
      }
      return await executeAdmitted({ claims, op, operation, payload, record, refuse, providerCall, authorizeStep, inTime });
    } finally {
      // Best effort: an entry left behind expires on its own.
      await activity.end(attempt).catch(() => {});
    }
  };

  const executeAdmitted = async ({ claims, op, operation, payload, record, refuse, providerCall, authorizeStep, inTime }) => {
    // Never reinterpret a token under a different registry than it was minted
    // for.
    if (claims.rv !== REGISTRY_VERSION) return refuse("registry-version-mismatch");
    // A gated operation this deployment has not enabled (spec AUTHOR-01).
    if (!operation && gatedOperations().has(op)) return refuse("operation-not-enabled");
    if (!operation || claims.op !== op) return refuse("operation-mismatch");
    if (!isOperationAllowed({ lang: claims.lang, fn: claims.fn, op, backend: claims.backend })) {
      return refuse("operation-not-allowed");
    }
    try {
      operation.validate(payload);
    } catch (e) {
      if (e instanceof PayloadRejected) return refuse("payload-rejected", 400, e.message);
      throw e;
    }
    const digest = argsDigest(payload);
    if (digest !== claims.argd) return refuse("args-mismatch");
    if (!(await once.claim(claims.jti, claims.exp))) return refuse("token-replayed", 409);

    const credential = await secrets.get(claims.conn);
    if (!credential) return refuse("no-credential");
    // A connection id alone is not enough: the credential must belong to the
    // owner and backend the token was minted for.
    if (credential.ownerUid !== claims.own || credential.backend !== claims.backend) {
      return refuse("credential-binding-mismatch");
    }

    if (operation.kind !== "write") {
      // A local signature is an effect: authorized immediately before it.
      try {
        await authorizeStep("sign", "sign");
      } catch (e) {
        const reason = authorizationReason(e);
        if (!reason) throw e;
        return refuse(reason, e instanceof AuthorizationDenied ? 403 : 503);
      }
      const result = await operation.run(payload, credential, { onStep: async () => {}, providerCall });
      await audit({ ...record, outcome: "allowed" });
      return { status: "succeeded", result };
    }

    const binding = {
      principal: claims.sub,
      ownerUid: claims.own,
      connectionId: claims.conn,
      lang: claims.lang,
      fn: claims.fn,
      op,
      registryVersion: claims.rv,
      argsDigest: digest,
    };
    return executeWrite({ claims, binding, operation, payload, credential, record, refuse, providerCall, authorizeStep, inTime });
  };

  const executeWrite = async ({ claims, binding, operation, payload, credential, record, refuse, providerCall, authorizeStep, inTime }) => {
    // A failure here (before any provider request) propagates: no claim, no
    // effects.
    const claimed = await receipts.claim(claims.opid, binding);
    if (!claimed.created) {
      const recorded = claimed.claim.binding;
      if (recorded.registryVersion !== binding.registryVersion) return refuse("receipt-registry-version-mismatch", 409);
      if (!sameBinding(recorded, binding)) return refuse("operation-id-reused", 409);
      // Returning a recorded outcome is an effect too. It is read first and
      // authorized last, so nothing awaited comes between the decision and
      // returning it. A refusal leaves the receipt as it is.
      const outcome = await receipts.getOutcome(claims.opid);
      const persistedSteps = outcome ? null : await receipts.getSteps(claims.opid);
      try {
        await authorizeStep("receipt", "replay");
        await audit({ ...record, outcome: "replayed", reason: outcome ? outcome.status : "uncertain" });
        inTime("replaying the receipt");
      } catch (e) {
        const reason = authorizationReason(e);
        if (!reason) throw e;
        return refuse(reason, e instanceof AuthorizationDenied ? 403 : 503);
      }
      return outcome
        ? { status: outcome.status, result: outcome.result, steps: outcome.steps, ...(outcome.reason ? { reason: outcome.reason } : {}), replayed: true }
        : { status: "uncertain", steps: persistedSteps, replayed: true };
    }

    // `steps` are the provider steps known to have completed; each is durable
    // before the operation may make its next provider request.
    const steps = [];
    const onStep = async step => {
      try {
        await receipts.putStep(claims.opid, steps.length, step);
      } catch (e) {
        throw new StepNotPersisted(step, e);
      }
      steps.push(step);
    };
    let status = "failed";
    let result;
    let error;
    let reason;
    try {
      result = await operation.run(payload, credential, { onStep, providerCall });
      status = "succeeded";
    } catch (e) {
      if (e instanceof StepNotPersisted) {
        // The provider completed a step whose record was lost: its effect is
        // real but not durable, so the operation is uncertain.
        status = "uncertain";
        steps.push(e.step);
        error = e.message;
      } else if (e instanceof ProviderRejected || authorizationReason(e)) {
        // Definite: the provider refused, or the next request was never sent
        // (deadline, or no authorization for it).
        status = steps.length > 0 ? "partial" : "failed";
        error = String(e?.message || e);
        reason = authorizationReason(e) ?? undefined;
      } else {
        status = "uncertain";
        error = String(e?.message || e);
      }
    }
    // Best effort: without a final outcome, a replay still reports uncertain
    // with the persisted steps, and the claim prevents any re-execution.
    let recorded = true;
    try {
      // `reason` only when there is one: Firestore refuses undefined fields.
      await receipts.putOutcome(claims.opid, { status, steps, result: result ?? null, ...(reason ? { reason } : {}) });
    } catch {
      recorded = false;
    }
    await audit({ ...record, outcome: status === "succeeded" ? "allowed" : status, ...(recorded ? (reason ? { reason } : {}) : { reason: "outcome-not-recorded" }) });
    if (!error) return { status, steps, result };
    return reason ? { status, steps, error, reason } : { status, steps, error };
  };

  // For the operator and candidate checks: on or off, and why.
  const protectedExecution = async () => {
    const { enabled, source } = await protectedSwitch.state();
    return { enabled, source };
  };

  // Writes in progress across all instances (for draining), and the longest
  // any execution can take.
  const activeExecutions = async () => ({ count: await activity.count(now()), maxExecutionMs: maxExecutionMs(limits) });

  return { execute, protectedExecution, activeExecutions };
};
