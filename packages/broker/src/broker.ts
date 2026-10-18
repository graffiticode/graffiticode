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
//   5a. A write's records are written under references derived from its
//      operation id (B1, registry v8; operations.js providerReferences), so a
//      save only ever creates records. The mapping is applied once, before the claim; the evidence, the
//      provider requests and the returned references all use it.
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
//   7a. A Questions preview is signed with the preview consumer
//      (previewConnections), never the token's connection: its signature
//      doesn't cover the request (AT-10 A3, registry v8). An Items preview, a
//      write and a reconciliation use the token's connection.
//   8. A `sign` under a system preview session (provenance `system`) first
//      claims one of the session's SYSTEM_SESSION_MAX_SIGNINGS slots
//      (session-slots.js); with all taken it is refused `session-exhausted`
//      (429) before any signing. The slot is claimed after the jti: each
//      token is claimed once, so it can take at most one slot and sign at
//      most once, and a token refused for want of a slot is spent, not
//      replayable (it could only be refused again: slots never free up while
//      the session can produce tokens). A slot taken by an execution that
//      then fails (authorization, signing) stays taken: the allowance counts
//      attempts, so it never allows more than N signatures. A system token
//      without a valid `sexp` is refused `bad-token` on arrival.
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
import { isOperationAllowed, isStepRegistered, REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import { verifyToken, provenanceRefusal, opidParts, MAINTENANCE, admission } from "@graffiticode/policy";
import { SUPPORTED_CONTRACT_VERSIONS } from "@graffiticode/common/contract";
import { argsDigest } from "./canonical.js";
import { DeadlineExceeded, PayloadRejected, ProviderRejected } from "./operations.js";
import { DEFAULT_LIMITS, headroomMs, maxExecutionMs } from "./limits.js";
import { AuthorizationDenied, AuthorizationUnavailable } from "./authorizer.js";
import { classify } from "@graffiticode/common/failures";
import { createMemorySessionSlotStore, type SessionSlotStore } from "./stores.js";
import { DEFAULT_SYSTEM_SESSION_MAX_SIGNINGS, slotExpiresAt, systemSessionClaimsValid } from "./session-slots.js";

// Only defined fields: Firestore refuses undefined values in a receipt.
const defined = fields => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

// What Broker records of a reason: a known one as it is, an unknown one (a
// Policy reason Broker's vocabulary doesn't list, relayed in
// `authorization-denied:<reason>`) as `unclassified-reason`, never the value.
const recordedReason = reason => (classify(reason).classified ? reason : "unclassified-reason");

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

// The contract a token's claims meet (W4; spec RELEASE-01, TOKEN-01): a
// version Broker doesn't support, or below its minimum, is refused; from
// minimum 2, a user-provenance token must be bound to an admitted plan and
// stage (`pld`, `stg`); and a bound token's stage must be its operation's.
// Policy decides the plan itself at each authorization; these are the checks
// Broker can make on the token alone, before anything is spent.
export const contractRefusal = (claims, minContractVersion = 1) => {
  const cv = claims.cv ?? 1;
  if (!SUPPORTED_CONTRACT_VERSIONS.includes(cv) || cv < minContractVersion) return "contract-version-unsupported";
  if (claims.pld !== undefined || claims.stg !== undefined) {
    if (!claims.pld || !claims.stg || claims.stg !== opidParts(claims.opid).stage) return "plan-binding-mismatch";
  } else if (minContractVersion >= 2 && claims.prv === "user") {
    return "plan-required";
  }
  return null;
};

export const createBroker = ({
  jwks, operations, secrets, once, receipts, activity, protectedSwitch, authorize, limits = DEFAULT_LIMITS, now = Date.now, audit, minContractVersion = 1,
  // A system preview session's signature allowance (session-slots.js).
  // main.js passes the Firestore store; the in-memory default still enforces
  // the allowance, per instance, for embedders and tests that don't.
  slots = createMemorySessionSlotStore() as SessionSlotStore, systemSessionMaxSignings = DEFAULT_SYSTEM_SESSION_MAX_SIGNINGS,
  // backend -> the connection id of its preview consumer (AT-10 A3,
  // registry v8; BROKER_PREVIEW_CONNECTIONS). An operation that `signsWith`
  // "preview-consumer" signs only with it; with none for its backend, it's
  // refused.
  previewConnections = {} as Record<string, string>,
}) => {
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
  if (!slots || typeof slots.claim !== "function") throw new Error("createBroker needs a session slot store");
  if (!(Number.isInteger(systemSessionMaxSignings) && systemSessionMaxSignings > 0)) throw new Error("createBroker needs a positive integer systemSessionMaxSignings");
  // B1 (registry v8): a write only creates records, under references its own
  // operation id derives; a write operation without the mapping isn't built.
  for (const [name, definition] of Object.entries(operations ?? {}) as [string, any][]) {
    if (definition?.kind === "write" && typeof definition.references !== "function") throw new Error(`createBroker: write operation ${name} needs a references mapping`);
    // Which credential a signature uses is the operation's to say, never a
    // default: a Questions preview signed with an owner's consumer would hand
    // out a general session on it.
    if (definition?.kind === "sign" && !["connection", "preview-consumer"].includes(definition.signsWith)) throw new Error(`createBroker: sign operation ${name} needs signsWith`);
  }
  if (!previewConnections || typeof previewConnections !== "object" || Object.values(previewConnections).some(id => typeof id !== "string" || !id)) {
    throw new Error("createBroker: previewConnections maps a backend to a connection id");
  }
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
    // Correlation from the verified token (spec AUDIT-01): the operation, its
    // invocation and stage, and who is executing it.
    const record = {
      event: "execute",
      uid: claims.sub,
      ownerUid: claims.own,
      connectionId: claims.conn,
      lang: claims.lang,
      fn: claims.fn,
      op,
      registryVersion: claims.rv,
      jti: claims.jti,
      opid: claims.opid,
      provenance: claims.prv,
      callerRole: caller?.role,
      planDigest: claims.pld,
      ...opidParts(claims.opid),
    };
    const refuse = async (reason: string, status?: number, detail?: unknown) => {
      await audit({ ...record, outcome: "denied", reason: recordedReason(reason) });
      throw new BrokerRefused(reason, status, detail);
    };

    // Only the compiler of the token's language may spend it.
    if (caller?.role !== "compiler" || caller.lang !== claims.lang) return refuse("caller-language-mismatch");
    // The authority it rests on (Policy's provenance.js), checked here too.
    const badProvenance = provenanceRefusal(claims);
    if (badProvenance) return refuse(badProvenance);
    // A system-session token carries its session's expiry (`sexp`), which its
    // signature slots are retained by; one without isn't valid.
    if (!systemSessionClaimsValid(claims)) return refuse("bad-token", 401);
    // The contract it was issued under, before anything is spent.
    const badContract = contractRefusal(claims, minContractVersion);
    if (badContract) return refuse(badContract, 409);
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
    // The step being authorized or sent: an operation that stops names it as
    // its `failedStep`.
    let stepInProgress = null;
    const providerCall = async step => {
      stepInProgress = step;
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
      return executeAdmitted({ claims, op, operation, payload, record, refuse, providerCall, authorizeStep, inTime, failedStep: () => stepInProgress });
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
      return await executeAdmitted({ claims, op, operation, payload, record, refuse, providerCall, authorizeStep, inTime, failedStep: () => stepInProgress });
    } finally {
      // Best effort: an entry left behind expires on its own.
      await activity.end(attempt).catch(() => {});
    }
  };

  const executeAdmitted = async ({ claims, op, operation, payload, record, refuse, providerCall, authorizeStep, inTime, failedStep }) => {
    // Never reinterpret a token under a different registry than it was minted
    // for.
    if (claims.rv !== REGISTRY_VERSION) return refuse("registry-version-mismatch");
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

    let credential;
    if (operation.signsWith === "preview-consumer") {
      // Signed with the preview consumer, whatever connection the
      // token names (AT-10 A3, registry v8). It adds no authority: a system
      // session signs the same preview with no connection at all. The token's
      // connection still authorized it (Policy's grant, the live check).
      const previewConnection = Object.prototype.hasOwnProperty.call(previewConnections, claims.backend) ? previewConnections[claims.backend] : null;
      if (!previewConnection) return refuse("preview-consumer-unconfigured", 503);
      credential = await secrets.get(previewConnection);
      if (!credential) return refuse("no-credential");
      if (credential.backend !== claims.backend) return refuse("credential-binding-mismatch");
    } else {
      credential = await secrets.get(claims.conn);
      if (!credential) return refuse("no-credential");
      // A connection id alone is not enough: the credential must belong to the
      // owner and backend the token was minted for.
      if (credential.ownerUid !== claims.own || credential.backend !== claims.backend) {
        return refuse("credential-binding-mismatch");
      }
    }

    if (operation.kind !== "write") {
      // A system session's signature allowance: one slot per signing, claimed
      // before its authorization and any signing, after the jti (see 8 above).
      if (claims.prv === "system") {
        const slot = await slots.claim(claims.sid, systemSessionMaxSignings, { expiresAt: slotExpiresAt(claims.sexp), jti: claims.jti, opid: claims.opid });
        if (slot === null) return refuse("session-exhausted", 429);
      }
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
    return executeWrite({ claims, binding, operation, payload, credential, record, refuse, providerCall, authorizeStep, inTime, failedStep });
  };

  const executeWrite = async ({ claims, binding, operation, payload, credential, record, refuse, providerCall, authorizeStep, inTime, failedStep }) => {
    // A failure here (before any provider request) propagates: no claim, no
    // effects.
    // The receipt names its plan (W4), so retiring a revision can report the
    // plans whose writes still need it.
    // The claim also records the write's evidence (WRITE-02, W5 stage 3): its
    // records, their references and digests, and where Broker puts its mark.
    // B1: the records as they will be written, mapped once from the payload
    // and the operation id, before the claim. The evidence, the provider
    // requests and the returned references all come from this one value; the
    // binding keeps the args digest of the payload as sent, so a retry binds,
    // and maps, exactly as before.
    const written = operation.references(payload, claims.opid);
    const evidence = operation.evidence?.(written);
    const claimed = await receipts.claim(claims.opid, binding, { ...(claims.pld ? { pld: claims.pld } : {}), ...(evidence ? { evidence } : {}) });
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
        ? { status: outcome.status, result: outcome.result, steps: outcome.steps, ...defined({ reason: outcome.reason, failedStep: outcome.failedStep, category: outcome.category }), replayed: true }
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
    let stopped;
    try {
      result = await operation.run(written, credential, { onStep, providerCall, operationId: claims.opid });
      status = "succeeded";
    } catch (e) {
      if (e instanceof StepNotPersisted) {
        // The provider completed a step whose record was lost: its effect is
        // real but not durable, so the operation is uncertain.
        status = "uncertain";
        steps.push(e.step);
        error = e.message;
        reason = "step-not-persisted";
        stopped = e.step;
      } else if (e instanceof ProviderRejected || authorizationReason(e)) {
        // Definite: the provider refused, or the next request was never sent
        // (deadline, or no authorization for it).
        status = steps.length > 0 ? "partial" : "failed";
        error = String(e?.message || e);
        reason = authorizationReason(e) ? recordedReason(authorizationReason(e)) : "provider-rejected";
        stopped = failedStep() ?? undefined;
      } else {
        // A dispatched step whose response never resolved: the provider may
        // have applied it, with no completed step known (steps may be []).
        status = "uncertain";
        error = String(e?.message || e);
        reason = "provider-response-lost";
        stopped = failedStep() ?? undefined;
      }
    }
    // Every non-success outcome has a reason, so its category (spec AUDIT-01).
    const category = reason ? classify(reason).category : undefined;
    const effects = defined({ reason, failedStep: stopped, category });
    // Best effort: without a final outcome, a replay still reports uncertain
    // with the persisted steps, and the claim prevents any re-execution.
    let recorded = true;
    try {
      await receipts.putOutcome(claims.opid, { status, steps, result: result ?? null, ...effects });
    } catch {
      recorded = false;
    }
    // The known prior effects (steps) go with the outcome, so a later failure
    // still says what was done (spec AUDIT-01).
    await audit({ ...record, outcome: status === "succeeded" ? "allowed" : status, steps, ...effects, ...(recorded ? {} : { reason: "outcome-not-recorded" }) });
    if (!error) return { status, steps, result };
    return { status, steps, error, ...effects };
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
