// The policy authority's two decisions, owner-only for now (delegation is a
// later phase and stays off until its own gate):
//
//   invocation  once per logical invocation, by the gateway before dispatch
//             (see invocations.js): a durable id that retries share and an
//             intentional rerun does not, in a token the compiler forwards.
//   snapshot  once per compile: which protected functions this invocation may
//             use through the selected connection. Returns the allowed set
//             (for the compiler's admission pass) and a session token binding
//             it to the user, connection, language, mode, invocation and
//             composition stage.
//   mint      once per broker operation: re-checks live state and the full
//             lang/fn/op/backend/mode relationship against the registry, and
//             issues a short execution token scoped to that one request. The
//             operation id is invocation/stage/occurrence, so a retry of the
//             same invocation reaches the same write receipt.
//
//   intent    issued to the console when a user deliberately saves or opens
//             the Author Site. Privileged modes (`save`, `author`) come ONLY
//             from a verified intent bound to the same user and connection;
//             a compiler cannot claim them. Until intents are removed, a write
//             still needs one; its identity comes from the invocation.
//
// Callers are authenticated before reaching here: `user` is the verified end
// user and `caller.lang` the language bound to the verified calling service.
// Every decision, allowed or denied, is audited.

import {
  EXEC_MODES,
  REGISTRY_VERSION,
  isOperationAllowed,
  protectedFunctionsForLang,
} from "@graffiticode/common/protected-registry";
import { randomUUID } from "node:crypto";
import { issueToken, verifyToken } from "./tokens.js";
import { connectionRefusal } from "./connections.js";
import { InvocationConflict } from "./invocations.js";

export class PolicyDenied extends Error {
  constructor(reason) {
    super(`policy denied: ${reason}`);
    this.reason = reason;
  }
}

const PRIVILEGED_MODES = Object.freeze(["save", "author"]);
const ID_RE = /^[A-Za-z0-9_:.-]{1,200}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const isId = v => typeof v === "string" && ID_RE.test(v);
const isTaskId = v => typeof v === "string" && v.length > 0 && v.length <= 4096;

export const createPolicy = ({ signer, jwks, connections, invocations, audit }) => {
  const deny = async (reason, record) => {
    await audit({ ...record, outcome: "denied", reason });
    throw new PolicyDenied(reason);
  };

  const issueIntent = async ({ caller, user, mode, connectionId }) => {
    const record = { event: "intent", uid: user?.uid, connectionId, mode };
    if (caller?.role !== "console") return deny("caller-not-entry-point", record);
    if (!user?.uid) return deny("no-user", record);
    if (!PRIVILEGED_MODES.includes(mode)) return deny("bad-mode", record);
    if (!isId(connectionId)) return deny("bad-request", record);
    const connection = await connections.get(connectionId);
    const refusal = connectionRefusal(connection, { uid: user.uid });
    if (refusal) return deny(refusal, { ...record, ownerUid: connection?.ownerUid });
    const saveActionId = mode === "save" ? randomUUID() : null;
    const intentToken = await issueToken(signer, "intent", { sub: user.uid, conn: connectionId, mode, sav: saveActionId });
    await audit({ ...record, ownerUid: connection.ownerUid, outcome: "allowed" });
    return { intentToken, saveActionId };
  };

  // Resolves the session's mode. Without an intent, the caller may pick a
  // non-privileged mode (they carry the same authority); a privileged mode
  // requires a verified intent for this user and connection.
  const resolveMode = async ({ mode, intentToken, user, connectionId }) => {
    if (!intentToken) {
      if (!EXEC_MODES.includes(mode)) return { error: "bad-mode" };
      return PRIVILEGED_MODES.includes(mode)
        ? { error: "privileged-mode-without-intent" }
        : { mode, saveActionId: null };
    }
    let intent;
    try {
      ({ claims: intent } = await verifyToken(jwks, "intent", intentToken));
    } catch {
      return { error: "bad-intent" };
    }
    if (intent.sub !== user.uid || intent.conn !== connectionId) return { error: "intent-mismatch" };
    if (!PRIVILEGED_MODES.includes(intent.mode)) return { error: "bad-intent" };
    return { mode: intent.mode, saveActionId: intent.sav ?? null };
  };

  const allocateInvocation = async ({ caller, user, connectionId, taskId, inputDigest, idempotencyKey = null }) => {
    const record = { event: "invocation", uid: user?.uid, connectionId };
    if (caller?.role !== "gateway") return deny("caller-not-entry-point", record);
    if (!user?.uid) return deny("no-user", record);
    if (!isId(connectionId) || !isTaskId(taskId) || typeof inputDigest !== "string" || !DIGEST_RE.test(inputDigest)) {
      return deny("bad-request", record);
    }
    if (idempotencyKey !== null && !isId(idempotencyKey)) return deny("bad-request", record);
    const connection = await connections.get(connectionId);
    const refusal = connectionRefusal(connection, { uid: user.uid });
    if (refusal) return deny(refusal, { ...record, ownerUid: connection?.ownerUid });
    let allocated;
    try {
      allocated = await invocations.allocate({ uid: user.uid, connectionId, taskId, inputDigest, idempotencyKey });
    } catch (e) {
      if (e instanceof InvocationConflict) return deny("idempotency-key-reused", record);
      throw e;
    }
    const { invocationId, seq, reused } = allocated;
    const invocationToken = await issueToken(signer, "invocation", { sub: user.uid, conn: connectionId, inv: invocationId, seq });
    await audit({ ...record, ownerUid: connection.ownerUid, outcome: "allowed", reason: reused ? "reused" : "new" });
    return { invocationToken, invocationId, seq, reused };
  };

  // The invocation comes only from a policy-issued invocation token for this
  // user and connection, never from the compiler's own say-so.
  const invocationFor = async ({ invocationToken, user, connectionId }) => {
    try {
      const { claims } = await verifyToken(jwks, "invocation", invocationToken);
      return claims.sub === user.uid && claims.conn === connectionId && isId(claims.inv) ? claims.inv : null;
    } catch {
      return null;
    }
  };

  const snapshot = async ({ caller, user, lang, connectionId, fns, mode: requestedMode = "read", intentToken, invocationToken, stage }) => {
    const record = { event: "snapshot", uid: user?.uid, lang, connectionId, mode: requestedMode, registryVersion: REGISTRY_VERSION };
    if (!user?.uid) return deny("no-user", record);
    if (caller?.role !== "compiler" || !caller.lang || caller.lang !== lang) return deny("caller-language-mismatch", record);
    if (!isId(connectionId) || typeof invocationToken !== "string" || !isId(stage)) return deny("bad-request", record);
    const invocationId = await invocationFor({ invocationToken, user, connectionId });
    if (!invocationId) return deny("bad-invocation", record);
    const resolved = await resolveMode({ mode: requestedMode, intentToken, user, connectionId });
    if (resolved.error) return deny(resolved.error, record);
    const { mode, saveActionId } = resolved;
    record.mode = mode;
    if (!Array.isArray(fns) || !fns.every(f => typeof f === "string")) return deny("bad-request", record);

    const connection = await connections.get(connectionId);
    const refusal = connectionRefusal(connection, { uid: user.uid });
    if (refusal) return deny(refusal, { ...record, ownerUid: connection?.ownerUid });

    // Owner-only: the owner holds every registered function of this language
    // that runs against this connection's backend in this mode. A write also
    // needs a save-action id, so a save request without one gets no writes.
    const registered = protectedFunctionsForLang(lang) || {};
    const allowed = [...new Set(fns)].filter(fn => {
      const spec = Object.prototype.hasOwnProperty.call(registered, fn) ? registered[fn] : null;
      return Boolean(
        spec &&
        spec.backend === connection.backend &&
        spec.modes.includes(mode) &&
        (spec.kind !== "write" || saveActionId !== null)
      );
    });

    const sessionToken = await issueToken(signer, "session", {
      sub: user.uid,
      own: connection.ownerUid,
      conn: connectionId,
      backend: connection.backend,
      lang,
      mode,
      inv: invocationId,
      stg: stage,
      sav: saveActionId,
      rv: REGISTRY_VERSION,
      fns: allowed,
    });
    await audit({ ...record, ownerUid: connection.ownerUid, outcome: "allowed" });
    // The resolved mode goes back to the compiler: it decides which writes to
    // disable from this, never from its own request.
    return { allowed, mode, sessionToken };
  };

  const mint = async ({ caller, sessionToken, fn, op, occurrenceId, argsDigest }) => {
    let session;
    try {
      ({ claims: session } = await verifyToken(jwks, "session", sessionToken));
    } catch {
      return deny("bad-session", { event: "mint", fn, op });
    }
    const record = {
      event: "mint",
      uid: session.sub,
      ownerUid: session.own,
      lang: session.lang,
      connectionId: session.conn,
      mode: session.mode,
      fn,
      op,
      registryVersion: session.rv,
    };
    if (caller?.role !== "compiler" || !caller.lang || caller.lang !== session.lang) return deny("caller-language-mismatch", record);
    if (session.rv !== REGISTRY_VERSION) return deny("registry-version-changed", record);
    if (!Array.isArray(session.fns) || !session.fns.includes(fn)) return deny("fn-not-in-session", record);
    if (!isOperationAllowed({ lang: session.lang, fn, op, backend: session.backend, mode: session.mode })) {
      return deny("operation-not-allowed", record);
    }
    if (!isId(occurrenceId) || typeof argsDigest !== "string" || !DIGEST_RE.test(argsDigest)) {
      return deny("bad-request", record);
    }
    const spec = protectedFunctionsForLang(session.lang)[fn];
    if (spec.kind === "write" && !session.sav) return deny("write-without-save-action", record);

    // Live state, re-read at every mint: a connection disabled, deleted or
    // re-owned since the snapshot stops the next protected call.
    const connection = await connections.get(session.conn);
    const refusal = connectionRefusal(connection, { uid: session.sub, ownerUid: session.own });
    if (refusal) return deny(refusal, record);
    if (connection.backend !== session.backend) return deny("backend-changed", record);

    // The invocation is durable and shared by its retries, and the stage and
    // occurrence are stable within it, so a retry reaches the same receipt.
    const operationId = `${session.inv}/${session.stg}/${occurrenceId}`;
    const executionToken = await issueToken(signer, "execution", {
      sub: session.sub,
      own: session.own,
      conn: session.conn,
      backend: session.backend,
      lang: session.lang,
      mode: session.mode,
      fn,
      op,
      sid: session.jti,
      opid: operationId,
      argd: argsDigest,
      rv: session.rv,
    });
    await audit({ ...record, outcome: "allowed" });
    return { executionToken, operationId };
  };

  return { issueIntent, allocateInvocation, snapshot, mint };
};
