// The policy authority's decisions. A connection's owner may use every
// registered function against its backend, unless they have narrowed their own
// use to a list (connections.js ownerPermissions); another account may use the
// delegable functions a live grant from the owner names (grants.js). There are
// no execution modes and no intents: running the program is the action, and
// the grant is the authority.
//
//   invocation  once per logical invocation, by the gateway before dispatch
//             (see invocations.js): a durable id that retries share and an
//             intentional rerun does not, in a token the compiler forwards.
//   snapshot  once per compile: which protected functions this invocation may
//             use through the selected connection. Returns the allowed set
//             (for the compiler's admission pass) and a session token binding
//             it to the user, connection, language, invocation and
//             composition stage.
//   preview-session  once per compile with NO user connection: a session on
//             the Graffiticode-owned system connection for the language's
//             backend (POLICY_SYSTEM_CONNECTIONS), carrying only the
//             language's system-preview functions (implicit, view-safe
//             signing). No user and no invocation; it can sign a render and
//             never write or open the Author Site.
//   mint      once per broker operation: re-checks live state and the full
//             lang/fn/op/backend relationship against the registry, and
//             issues a short execution token scoped to that one request. The
//             operation id is invocation/stage/occurrence, so a retry of the
//             same invocation reaches the same write receipt.
//
// Callers are authenticated before reaching here: `user` is the verified end
// user and `caller.lang` the language bound to the verified calling service.
// Every decision, allowed or denied, is audited.

import {
  REGISTRY_VERSION,
  isOperationAllowed,
  protectedFunctionsForLang,
  systemPreviewFunctionsForLang,
  viewSafeFunctionsForLang,
} from "@graffiticode/common/protected-registry";
import { createHash, randomUUID } from "node:crypto";
import { issueToken, verifyToken } from "./tokens.js";
import { grantIdFor, isExpired } from "./grants.js";
import { InvocationConflict } from "./invocations.js";
import { newPublicationId } from "./publications.js";
import { MAINTENANCE, admission } from "./maintenance.js";

export class PolicyDenied extends Error {
  constructor(reason) {
    super(`policy denied: ${reason}`);
    this.reason = reason;
  }
}

// Protected execution is switched off (maintenance.js): not a judgement on the
// request, which may be retried once it is back on.
export class PolicyMaintenance extends PolicyDenied {
  constructor() {
    super(MAINTENANCE);
  }
}

const ID_RE = /^[A-Za-z0-9_:.-]{1,200}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const isId = v => typeof v === "string" && ID_RE.test(v);
const isTaskId = v => typeof v === "string" && v.length > 0 && v.length <= 4096;
const isLang = v => typeof v === "string" && /^\d{4}$/.test(v);
// Every view of one publication shares one invocation, keyed by this input.
const VIEW_INPUT = createHash("sha256").update("publication-view").digest("hex");
// The subject of a system preview session: there is no user.
export const SYSTEM_PREVIEW_SUBJECT = "system-preview";

export const createPolicy = ({ signer, jwks, connections, invocations, publications, grants = null, systemConnections = {}, protectedSwitch, audit }) => {
  // No default: a policy built without the switch would run ungated.
  if (!protectedSwitch || typeof protectedSwitch.state !== "function") throw new Error("createPolicy needs a protectedSwitch");
  const deny = async (reason, record) => {
    await audit({ ...record, outcome: "denied", reason });
    throw new PolicyDenied(reason);
  };
  // Every protected entry point asks first, before reading or issuing
  // anything. `principal` is verified identity only (the authenticated user,
  // or a verified token's claims): while paused, it admits the canary.
  const requireProtectedExecution = async (record, principal = {}) => {
    const admitted = admission(await protectedSwitch.state(), principal);
    if (admitted === "enabled") return;
    if (admitted === "canary") {
      await audit({ ...record, outcome: "allowed", reason: "canary-during-maintenance" });
      return;
    }
    await audit({ ...record, outcome: "denied", reason: MAINTENANCE });
    throw new PolicyMaintenance();
  };

  // Who may use a connection, read live: its owner, or a recipient with an
  // unexpired grant from that owner. `ownerUid` pins the owner a session or
  // publication was issued under, so a changed owner stops it.
  // A configured system connection serves only system preview sessions: no
  // user, publication or grant reaches it, its owner included, so it can never
  // write, sign Author or back a publication.
  const isSystemConnection = connectionId => Object.values(systemConnections).includes(connectionId);
  // @ts-expect-error TS-MIGRATE: checkJs infers a destructured parameter's type from its default; optional fields read as missing
  const accessFor = async (connection, uid, { ownerUid } = {}) => {
    if (!connection) return { refusal: "connection-not-found" };
    if (isSystemConnection(connection.connectionId)) return { refusal: "system-connection" };
    if (connection.status !== "active") return { refusal: "connection-disabled" };
    if (ownerUid !== undefined && connection.ownerUid !== ownerUid) return { refusal: "owner-changed" };
    if (connection.ownerUid === uid) return { owner: true, permissions: connection.ownerPermissions ?? null };
    const grant = grants && uid
      ? await grants.get(grantIdFor({ connectionId: connection.connectionId, recipientUid: uid }))
      : null;
    if (!grant || isExpired(grant) || grant.ownerUid !== connection.ownerUid) return { refusal: "not-owner" };
    return { grant };
  };
  // A grant reaches the (language, function) pairs it names that the registry
  // marks delegable, plus that language's implicit delegable functions (signing
  // every render), which also may be named on their own. The owner reaches
  // every registered function, or, once they have narrowed their own use, the
  // ones their list names by the same rule, delegable or not. A list without
  // permissions reaches nothing.
  const mayUse = (access, lang, fn) => {
    const spec = protectedFunctionsForLang(lang)?.[fn];
    if (!spec) return false;
    if (access.owner && access.permissions === null) return true;
    const key = String(lang ?? "").replace(/^L/i, "").padStart(4, "0");
    const list = access.owner ? access.permissions : access.grant?.permissions;
    const inLang = (list ?? []).filter(p => p.lang === key);
    const permitted = inLang.some(p => p.fn === fn) || (spec.implicit === true && inLang.length > 0);
    return permitted && (access.owner || spec.delegable === true);
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
    const access = await accessFor(connection, user.uid);
    if (access.refusal) return deny(access.refusal, { ...record, ownerUid: connection?.ownerUid });
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
    // The owner and sequence go back to the gateway, which binds the private
    // result of this invocation to them.
    return { invocationToken, invocationId, seq, reused, ownerUid: connection.ownerUid };
  };

  // The invocation comes only from a policy-issued invocation token for this
  // connection, never from the compiler's own say-so.
  const invocationClaims = async ({ invocationToken, connectionId }) => {
    try {
      const { claims } = await verifyToken(jwks, "invocation", invocationToken);
      return claims.conn === connectionId && isId(claims.inv) && typeof claims.sub === "string" ? claims : null;
    } catch {
      return null;
    }
  };

  // Live state of a publication, checked at publishing, at every view and at
  // every mint. Owner-only: the publisher must own the connection, and it must
  // be active. Returns { refusal } or { publication, connection }.
  // @ts-expect-error TS-MIGRATE: checkJs infers a destructured parameter's type from its default; optional fields read as missing
  const publicationState = async (publicationId, { publisherUid, connectionId, lang } = {}) => {
    const publication = isId(publicationId) ? await publications.get(publicationId) : null;
    if (!publication) return { refusal: "publication-not-found" };
    if ((publisherUid !== undefined && publication.publisherUid !== publisherUid) ||
        (connectionId !== undefined && publication.connectionId !== connectionId) ||
        (lang !== undefined && publication.lang !== lang)) {
      return { refusal: "publication-mismatch" };
    }
    const connection = await connections.get(publication.connectionId);
    const access = await accessFor(connection, publication.publisherUid, { ownerUid: publication.ownerUid });
    if (access.refusal) return { refusal: access.refusal };
    // Only the owner publishes; a grant never includes publishing.
    if (access.grant) return { refusal: "publish-not-granted" };
    return { publication, connection, access };
  };

  // Publishing: the gateway has checked that the artifact is this user's
  // current result for the task and connection; policy checks the authority.
  const createPublication = async ({ caller, user, connectionId, taskId, lang, artifactInvocationId }) => {
    const record = { event: "publication-create", uid: user?.uid, connectionId, lang };
    if (caller?.role !== "gateway") return deny("caller-not-entry-point", record);
    if (!user?.uid) return deny("no-user", record);
    if (!isId(connectionId) || !isTaskId(taskId) || !isLang(lang) || !isId(artifactInvocationId)) {
      return deny("bad-request", record);
    }
    const connection = await connections.get(connectionId);
    const access = await accessFor(connection, user.uid);
    if (access.refusal) return deny(access.refusal, { ...record, ownerUid: connection?.ownerUid });
    // Published views spend the owner's credential on viewers the owner never
    // named, so a recipient needs a grant that says so.
    if (access.grant) return deny("publish-not-granted", { ...record, ownerUid: connection.ownerUid });
    const publication = await publications.create({
      publicationId: newPublicationId(),
      publisherUid: user.uid,
      ownerUid: connection.ownerUid,
      connectionId,
      lang,
      taskId,
      artifactInvocationId,
      createdAt: new Date().toISOString(),
    });
    await audit({ ...record, ownerUid: connection.ownerUid, outcome: "allowed" });
    return { publicationId: publication.publicationId };
  };

  const deletePublication = async ({ caller, user, publicationId }) => {
    const record = { event: "publication-delete", uid: user?.uid };
    if (caller?.role !== "gateway") return deny("caller-not-entry-point", record);
    if (!user?.uid) return deny("no-user", record);
    const publication = isId(publicationId) ? await publications.get(publicationId) : null;
    if (!publication) return deny("publication-not-found", record);
    if (publication.publisherUid !== user.uid) return deny("not-publisher", record);
    await publications.delete(publicationId);
    await audit({ ...record, connectionId: publication.connectionId, outcome: "allowed" });
    return { publicationId, deleted: true };
  };

  // A view of a published item: no user. Policy re-checks the publication
  // live and issues an invocation token bound to the publisher and marked with
  // the publication, which confines its session to viewSafe functions.
  const authorizeView = async ({ caller, publicationId }) => {
    const record = { event: "publication-view" };
    if (caller?.role !== "gateway") return deny("caller-not-entry-point", record);
    const state = await publicationState(publicationId);
    if (state.refusal) return deny(state.refusal, record);
    const { publication } = state;
    const { invocationId, seq } = await invocations.allocate({
      uid: publication.publisherUid,
      connectionId: publication.connectionId,
      taskId: publication.taskId,
      inputDigest: VIEW_INPUT,
      idempotencyKey: `view.${publication.publicationId}`,
    });
    const invocationToken = await issueToken(signer, "invocation", {
      sub: publication.publisherUid,
      conn: publication.connectionId,
      inv: invocationId,
      seq,
      pub: publication.publicationId,
    });
    await audit({ ...record, uid: publication.publisherUid, connectionId: publication.connectionId, outcome: "allowed" });
    const { publisherUid, connectionId, lang, taskId, artifactInvocationId } = publication;
    return { invocationToken, publisherUid, connectionId, lang, taskId, artifactInvocationId };
  };

  // A publication session: the publisher's authority, confined to viewSafe
  // functions.
  const publicationSnapshot = async ({ record, claims, lang, connectionId, fns, stage }) => {
    const state = await publicationState(claims.pub, { publisherUid: claims.sub, connectionId, lang });
    if (state.refusal) return deny(state.refusal, record);
    const { connection, access } = state;
    const registered = protectedFunctionsForLang(lang) || {};
    const viewSafe = new Set(viewSafeFunctionsForLang(lang));
    const allowed = [...new Set(fns)].filter(fn =>
      viewSafe.has(fn) && registered[fn].backend === connection.backend && mayUse(access, lang, fn));
    const sessionToken = await issueToken(signer, "session", {
      sub: claims.sub,
      own: connection.ownerUid,
      conn: connectionId,
      backend: connection.backend,
      lang,
      inv: claims.inv,
      stg: stage,
      pub: claims.pub,
      rv: REGISTRY_VERSION,
      fns: allowed,
    });
    await audit({ ...record, uid: claims.sub, ownerUid: connection.ownerUid, outcome: "allowed", reason: "publication" });
    return { allowed, sessionToken };
  };

  const snapshot = async ({ caller, user, lang, connectionId, fns, invocationToken, stage }) => {
    const record = { event: "snapshot", uid: user?.uid, lang, connectionId, registryVersion: REGISTRY_VERSION };
    // The user is verified; the connection is checked against it below, as
    // for anyone.
    await requireProtectedExecution(record, { uid: user?.uid, connectionId });
    if (caller?.role !== "compiler" || !caller.lang || caller.lang !== lang) return deny("caller-language-mismatch", record);
    if (!isId(connectionId) || typeof invocationToken !== "string" || !isId(stage)) return deny("bad-request", record);
    if (!Array.isArray(fns) || !fns.every(f => typeof f === "string")) return deny("bad-request", record);
    const claims = await invocationClaims({ invocationToken, connectionId });
    if (!claims) return deny("bad-invocation", record);
    if (claims.pub) return publicationSnapshot({ record, claims, lang, connectionId, fns, stage });
    if (!user?.uid) return deny("no-user", record);
    if (claims.sub !== user.uid) return deny("bad-invocation", record);
    const invocationId = claims.inv;

    const connection = await connections.get(connectionId);
    const access = await accessFor(connection, user.uid);
    if (access.refusal) return deny(access.refusal, { ...record, ownerUid: connection?.ownerUid });

    // The owner holds every registered function of this language that runs
    // against this connection's backend (or those their own list names); a
    // recipient, the delegable ones their
    // grant names. A write runs whenever the program calls it; its identity is
    // the invocation's.
    const registered = protectedFunctionsForLang(lang) || {};
    const allowed = [...new Set(fns)].filter(fn => {
      const spec = Object.prototype.hasOwnProperty.call(registered, fn) ? registered[fn] : null;
      return Boolean(spec && spec.backend === connection.backend && mayUse(access, lang, fn));
    });

    const sessionToken = await issueToken(signer, "session", {
      sub: user.uid,
      own: connection.ownerUid,
      conn: connectionId,
      backend: connection.backend,
      lang,
      inv: invocationId,
      stg: stage,
      rv: REGISTRY_VERSION,
      fns: allowed,
    });
    await audit({ ...record, ownerUid: connection.ownerUid, outcome: "allowed" });
    return { allowed, sessionToken };
  };

  // The one backend a language's system-preview functions run against, or
  // null when there are none (or, defensively, more than one).
  const systemPreviewBackend = lang => {
    const registered = protectedFunctionsForLang(lang) || {};
    const backends = new Set(systemPreviewFunctionsForLang(lang).map(fn => registered[fn].backend));
    return backends.size === 1 ? [...backends][0] : null;
  };
  const systemConnectionFor = backend =>
    backend && Object.prototype.hasOwnProperty.call(systemConnections, backend) ? systemConnections[backend] : null;
  // Live state of a system connection: still the one configured for its
  // backend, present, active, same backend, same owner.
  const systemConnectionRefusal = async ({ connectionId, backend, ownerUid }) => {
    if (systemConnectionFor(backend) !== connectionId) return { refusal: "not-system-connection" };
    const connection = await connections.get(connectionId);
    if (!connection) return { refusal: "connection-not-found" };
    if (connection.status !== "active") return { refusal: "connection-disabled" };
    if (connection.backend !== backend) return { refusal: "backend-changed" };
    if (ownerUid !== undefined && connection.ownerUid !== ownerUid) return { refusal: "owner-changed" };
    return { connection };
  };

  // A compile with no user connection: the compiler asks for a session on
  // the system connection. No user, no invocation; the session carries only
  // the system-preview functions and is marked `sys`, which mint confines to
  // them.
  const previewSession = async ({ caller, lang }) => {
    const record = { event: "preview-session", lang, registryVersion: REGISTRY_VERSION };
    await requireProtectedExecution(record);
    if (caller?.role !== "compiler" || !caller.lang || caller.lang !== lang) return deny("caller-language-mismatch", record);
    if (!isLang(lang)) return deny("bad-request", record);
    const fns = systemPreviewFunctionsForLang(lang);
    const backend = systemPreviewBackend(lang);
    if (fns.length === 0 || !backend) return deny("no-system-preview-functions", record);
    const connectionId = systemConnectionFor(backend);
    if (!connectionId) return deny("no-system-connection", record);
    // @ts-expect-error TS-MIGRATE: checkJs infers a destructured parameter's type from its default; optional fields read as missing
    const state = await systemConnectionRefusal({ connectionId, backend });
    if (state.refusal) return deny(state.refusal, { ...record, connectionId });
    const { connection } = state;
    const sessionToken = await issueToken(signer, "session", {
      sub: SYSTEM_PREVIEW_SUBJECT,
      own: connection.ownerUid,
      conn: connectionId,
      backend,
      lang,
      // No invocation: signing writes nothing, so the operation id only needs
      // to be unique to this session.
      inv: `sys-${randomUUID()}`,
      stg: "preview",
      sys: true,
      rv: REGISTRY_VERSION,
      fns,
    });
    await audit({ ...record, connectionId, ownerUid: connection.ownerUid, outcome: "allowed", reason: "system-preview" });
    return { allowed: fns, sessionToken };
  };

  const mint = async ({ caller, sessionToken, fn, op, occurrenceId, argsDigest }) => {
    let session;
    try {
      ({ claims: session } = await verifyToken(jwks, "session", sessionToken));
    } catch {
      // Paused takes precedence over a bad token: say so first.
      await requireProtectedExecution({ event: "mint", fn, op });
      return deny("bad-session", { event: "mint", fn, op });
    }
    await requireProtectedExecution({ event: "mint", uid: session.sub, connectionId: session.conn, fn, op }, { uid: session.sub, connectionId: session.conn });
    const record = {
      event: "mint",
      uid: session.sub,
      ownerUid: session.own,
      lang: session.lang,
      connectionId: session.conn,
      fn,
      op,
      registryVersion: session.rv,
    };
    if (caller?.role !== "compiler" || !caller.lang || caller.lang !== session.lang) return deny("caller-language-mismatch", record);
    if (session.rv !== REGISTRY_VERSION) return deny("registry-version-changed", record);
    if (!Array.isArray(session.fns) || !session.fns.includes(fn)) return deny("fn-not-in-session", record);
    if (!isOperationAllowed({ lang: session.lang, fn, op, backend: session.backend })) {
      return deny("operation-not-allowed", record);
    }
    if (!isId(occurrenceId) || typeof argsDigest !== "string" || !DIGEST_RE.test(argsDigest)) {
      return deny("bad-request", record);
    }
    // A system preview session has no user and no grant: it reaches only the
    // language's system-preview functions, through the connection still
    // configured as the system connection for its backend.
    if (session.sys === true) {
      if (session.sub !== SYSTEM_PREVIEW_SUBJECT || session.pub) return deny("bad-session", record);
      if (!systemPreviewFunctionsForLang(session.lang).includes(fn)) return deny("not-system-preview", record);
      const state = await systemConnectionRefusal({ connectionId: session.conn, backend: session.backend, ownerUid: session.own });
      if (state.refusal) return deny(state.refusal, record);
      return issueExecution({ session, fn, op, argsDigest, occurrenceId, record });
    }
    // A user session never claims the system subject.
    if (session.sys !== undefined || session.sub === SYSTEM_PREVIEW_SUBJECT) return deny("bad-session", record);
    // A publication session re-checks the publication at every mint, and can
    // only ever reach viewSafe functions.
    if (session.pub) {
      if (!viewSafeFunctionsForLang(session.lang).includes(fn)) return deny("not-view-safe", record);
      const state = await publicationState(session.pub, { publisherUid: session.sub, connectionId: session.conn, lang: session.lang });
      if (state.refusal) return deny(state.refusal, record);
    }

    // Live state, re-read at every mint: a connection disabled, deleted or
    // re-owned since the snapshot stops the next protected call.
    const connection = await connections.get(session.conn);
    const access = await accessFor(connection, session.sub, { ownerUid: session.own });
    if (access.refusal) return deny(access.refusal, record);
    if (connection.backend !== session.backend) return deny("backend-changed", record);
    // A grant revoked or narrowed since the snapshot stops this call.
    if (!mayUse(access, session.lang, fn)) return deny("not-granted", record);
    return issueExecution({ session, fn, op, argsDigest, occurrenceId, record });
  };

  const issueExecution = async ({ session, fn, op, argsDigest, occurrenceId, record }) => {
    // The invocation is durable and shared by its retries, and the stage and
    // occurrence are stable within it, so a retry reaches the same receipt.
    const operationId = `${session.inv}/${session.stg}/${occurrenceId}`;
    const executionToken = await issueToken(signer, "execution", {
      sub: session.sub,
      own: session.own,
      conn: session.conn,
      backend: session.backend,
      lang: session.lang,
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

  // For the operator and candidate checks: on or off, and why. Never the flag's
  // other fields.
  const protectedExecution = async () => {
    const { enabled, source } = await protectedSwitch.state();
    return { enabled, source };
  };

  return { allocateInvocation, createPublication, deletePublication, authorizeView, snapshot, previewSession, mint, protectedExecution };
};
