// The policy authority's two decisions, owner-only for now (delegation is a
// later phase and stays off until its own gate):
//
//   snapshot  once per compile: which protected functions this invocation may
//             use through the selected connection. Returns the allowed set
//             (for the compiler's admission pass) and a session token binding
//             it to the user, connection, language, mode and invocation.
//   mint      once per broker operation: re-checks live state and the full
//             lang/fn/op/backend/mode relationship against the registry, and
//             issues a short execution token scoped to that one request.
//
//   intent    issued to the console when a user deliberately saves or opens
//             the Author Site. Privileged modes (`save`, `author`) come ONLY
//             from a verified intent bound to the same user and connection;
//             a compiler cannot claim them. The save-action id is minted
//             here, and a retried job carrying the same intent keeps it.
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

export const createPolicy = ({ signer, jwks, connections, audit }) => {
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

  const snapshot = async ({ caller, user, lang, connectionId, fns, mode: requestedMode = "read", intentToken, invocationId }) => {
    const record = { event: "snapshot", uid: user?.uid, lang, connectionId, mode: requestedMode, registryVersion: REGISTRY_VERSION };
    if (!user?.uid) return deny("no-user", record);
    if (caller?.role !== "compiler" || !caller.lang || caller.lang !== lang) return deny("caller-language-mismatch", record);
    if (!isId(connectionId) || !isId(invocationId)) return deny("bad-request", record);
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

    // A write's operation id comes from the save action, so retries of the same
    // save — across new HTTP requests or job re-dispatches — reuse it; anything
    // else is scoped to this invocation.
    const operationId = spec.kind === "write" ? `${session.sav}/${occurrenceId}` : `${session.inv}/${occurrenceId}`;
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

  return { issueIntent, snapshot, mint };
};
