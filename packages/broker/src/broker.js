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
//
// Time limits (limits.js): each provider request has a timeout, and no request
// starts after the operation's deadline. A request that times out is
// uncertain; one never started because of the deadline is definite (failed,
// or partial after earlier steps). A write registers in `activity` before its
// receipt claim and leaves when it finishes, so an operator can wait for
// active writes to drain.
//
// While protected execution is switched off, every execution is refused with
// `maintenance` (503) right after the token and caller check, except the
// configured canary's (its token's principal and connection), audited as such.
//
// Every decision is audited (pseudonymous ids; no tokens, secrets or bodies).

import { isOperationAllowed, REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import { verifyToken, MAINTENANCE, admission } from "@graffiticode/policy";
import { argsDigest } from "./canonical.js";
import { DeadlineExceeded, PayloadRejected, ProviderRejected } from "./operations.js";
import { DEFAULT_LIMITS, maxExecutionMs } from "./limits.js";

export class BrokerRefused extends Error {
  constructor(reason, status = 403, detail) {
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

export const createBroker = ({ jwks, operations, secrets, once, receipts, activity, protectedSwitch, limits = DEFAULT_LIMITS, now = Date.now, audit }) => {
  // No default: a broker built without the switch would run ungated.
  if (!protectedSwitch || typeof protectedSwitch.state !== "function") throw new Error("createBroker needs a protectedSwitch");
  // Nor without activity tracking, which draining relies on.
  if (!activity || typeof activity.begin !== "function") throw new Error("createBroker needs an activity store");
  // Starts the operation's clock. `providerCall` is called just before each
  // provider request: past the deadline it refuses (DeadlineExceeded),
  // otherwise it returns that request's timeout.
  const startClock = () => {
    const deadline = now() + limits.executionMs;
    return () => {
      const remaining = deadline - now();
      if (remaining <= 0) throw new DeadlineExceeded(`operation deadline of ${limits.executionMs} ms passed before the next provider request`);
      return Math.min(limits.providerCallMs, remaining);
    };
  };
  const execute = async ({ caller, token, op, payload }) => {
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
    const refuse = async (reason, status, detail) => {
      await audit({ ...record, outcome: "denied", reason });
      throw new BrokerRefused(reason, status, detail);
    };

    // Only the compiler of the token's language may spend it.
    if (caller?.role !== "compiler" || caller.lang !== claims.lang) return refuse("caller-language-mismatch");
    // Protected execution switched off (@graffiticode/policy maintenance.js):
    // refused before anything stateful, so the token is not spent and a retry
    // within its lifetime can still run once execution is back on.
    // While paused, the canary still runs: matched on the verified token's
    // principal and connection, never on request fields.
    const admitted = admission(await protectedSwitch.state(), { uid: claims.sub, connectionId: claims.conn });
    if (!admitted) return refuse(MAINTENANCE, 503);
    if (admitted === "canary") await audit({ ...record, outcome: "allowed", reason: "canary-during-maintenance" });
    // Never reinterpret a token under a different registry than it was minted
    // for.
    if (claims.rv !== REGISTRY_VERSION) return refuse("registry-version-mismatch");
    const operation = Object.prototype.hasOwnProperty.call(operations, op) ? operations[op] : null;
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
      const result = await operation.run(payload, credential, { onStep: async () => {}, providerCall: startClock() });
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
    // Registered before the claim, so an active write is always counted. A
    // failure here propagates before any claim or provider request.
    await activity.begin(claims.opid, now() + maxExecutionMs(limits));
    try {
      return await executeWrite({ claims, binding, operation, payload, credential, record, refuse });
    } finally {
      // Best effort: an entry left behind expires at its deadline.
      await activity.end(claims.opid).catch(() => {});
    }
  };

  const executeWrite = async ({ claims, binding, operation, payload, credential, record, refuse }) => {
    const claimed = await receipts.claim(claims.opid, binding);
    if (!claimed.created) {
      const recorded = claimed.claim.binding;
      if (recorded.registryVersion !== binding.registryVersion) return refuse("receipt-registry-version-mismatch", 409);
      if (!sameBinding(recorded, binding)) return refuse("operation-id-reused", 409);
      const outcome = await receipts.getOutcome(claims.opid);
      await audit({ ...record, outcome: "replayed", reason: outcome ? outcome.status : "uncertain" });
      return outcome
        ? { status: outcome.status, result: outcome.result, steps: outcome.steps, replayed: true }
        : { status: "uncertain", replayed: true };
    }

    const steps = [];
    let status = "failed";
    let result;
    let error;
    try {
      result = await operation.run(payload, credential, { onStep: async step => { steps.push(step); }, providerCall: startClock() });
      status = "succeeded";
    } catch (e) {
      if (e instanceof ProviderRejected || e instanceof DeadlineExceeded) {
        status = steps.length > 0 ? "partial" : "failed";
      } else {
        status = "uncertain";
      }
      error = String(e?.message || e);
    }
    await receipts.putOutcome(claims.opid, { status, steps, result: result ?? null });
    await audit({ ...record, outcome: status === "succeeded" ? "allowed" : status });
    return error ? { status, steps, error } : { status, steps, result };
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
