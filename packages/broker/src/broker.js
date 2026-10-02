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
// Every decision is audited (pseudonymous ids; no tokens, secrets or bodies).

import { gatedOperations, isOperationAllowed, REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import { verifyToken } from "@graffiticode/policy";
import { argsDigest } from "./canonical.js";
import { PayloadRejected, ProviderRejected } from "./operations.js";

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
      result = await operation.run(payload, credential, { onStep: async step => { steps.push(step); } });
      status = "succeeded";
    } catch (e) {
      if (e instanceof ProviderRejected) {
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

  return { execute };
};
