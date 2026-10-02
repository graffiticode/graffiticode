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
//
// Every decision is audited (pseudonymous ids; no tokens, secrets or bodies).

import { isOperationAllowed, REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import { verifyToken } from "@graffiticode/policy";
import { argsDigest } from "./canonical.js";
import { PayloadRejected, ProviderRejected } from "./operations.js";

// A provider step completed but could not be persisted; the operation must
// not take its next step.
class StepNotPersisted extends Error {
  constructor(step, cause) {
    super(`step ${step} completed but could not be recorded: ${String(cause?.message || cause)}`);
    this.step = step;
  }
}

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

export const createBroker = ({ jwks, operations, secrets, once, receipts, audit }) => {
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
      const result = await operation.run(payload, credential, { onStep: async () => {} });
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
    // A failure here (before any provider request) propagates: no claim, no
    // effects.
    const claimed = await receipts.claim(claims.opid, binding);
    if (!claimed.created) {
      const recorded = claimed.claim.binding;
      if (recorded.registryVersion !== binding.registryVersion) return refuse("receipt-registry-version-mismatch", 409);
      if (!sameBinding(recorded, binding)) return refuse("operation-id-reused", 409);
      const outcome = await receipts.getOutcome(claims.opid);
      await audit({ ...record, outcome: "replayed", reason: outcome ? outcome.status : "uncertain" });
      return outcome
        ? { status: outcome.status, result: outcome.result, steps: outcome.steps, replayed: true }
        : { status: "uncertain", steps: await receipts.getSteps(claims.opid), replayed: true };
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
    try {
      result = await operation.run(payload, credential, { onStep });
      status = "succeeded";
    } catch (e) {
      if (e instanceof StepNotPersisted) {
        // The provider completed a step whose record was lost: its effect is
        // real but not durable, so the operation is uncertain.
        status = "uncertain";
        steps.push(e.step);
        error = e.message;
      } else if (e instanceof ProviderRejected) {
        status = steps.length > 0 ? "partial" : "failed";
        error = String(e?.message || e);
      } else {
        status = "uncertain";
        error = String(e?.message || e);
      }
    }
    // Best effort: without a final outcome, a replay still reports uncertain
    // with the persisted steps, and the claim prevents any re-execution.
    let recorded = true;
    try {
      await receipts.putOutcome(claims.opid, { status, steps, result: result ?? null });
    } catch {
      recorded = false;
    }
    await audit({ ...record, outcome: status === "succeeded" ? "allowed" : status, ...(recorded ? {} : { reason: "outcome-not-recorded" }) });
    return error ? { status, steps, error } : { status, steps, result };
  };

  return { execute };
};
