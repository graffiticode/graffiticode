// Owner-side connection lifecycle, called by the console on behalf of a
// verified user. The credential passes through here to the broker (the only
// place it is stored, sealed) and is never stored, returned or logged by
// policy. Every change is audited as a lifecycle event.
//
//   list     the owner's connections (no secrets); system marks a configured
//            system connection (preview signing only, never writes)
//   create   new connection: secret to the broker first, then the record, so a
//            record never exists without its credential
//   rotate   replace the secret; grants attach to the connection, so they
//            survive rotation. Owner, backend and provider account (the key)
//            are immutable; the broker refuses a change to any of them
//   disable  stop all use at the next snapshot or mint
//   remove   delete the record, its grants, then the secret
//
// Sharing (delegation), also called by the console for a verified user:
//   shareable    the owner lists what a grant on this connection can include:
//                each language's delegable functions against its backend
//   functions    every protected function on the connection's backend, with
//                its kind and whether it is implicit and delegable
//   setOwnerPermissions  the owner limits their own use (null: everything)
//   share        the owner grants exact (language, function) permissions to an account, or to an email hash until that
//                person signs in (pending)
//   grants       the owner lists a connection's grants
//   update       the owner changes one grant's access or end date; the next
//                call the recipient makes sees it
//   revoke       the owner removes one; it stops the recipient's next call
//   shared       a recipient lists connections shared with them
//   leave        a recipient drops a grant
//   claim        a recipient turns pending grants for their emails into grants

import { randomUUID } from "node:crypto";
import { OPERATIONS, PROTECTED_FUNCTIONS, isGatedFunction } from "@graffiticode/common/protected-registry";
import { PolicyDenied } from "./policy.js";
import { grantIdFor, isExpired } from "./grants.js";
import { BrokerConflict } from "./broker-admin.js";

const BACKENDS = new Set(Object.values(OPERATIONS).map(op => op.backend));
const LABEL_MAX = 100;

const ID_RE = /^[A-Za-z0-9_:.-]{1,200}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

// Permissions are (language, function) pairs, and a language's protected
// functions against the connection's backend are the only ones there are
// (registry). The owner's own list may name any of them; a grant only the
// delegable ones, so Author signing never reaches a recipient. A language's
// implicit functions (signing every render) may be named on their own, so a
// list can allow previews and nothing else; they also come with any other
// permission in that language (policy.js mayUse).
const registered = backend => Object.entries(PROTECTED_FUNCTIONS).flatMap(([lang, fns]) => Object.entries(fns)
  .filter(([, spec]) => spec.backend === backend)
  .map(([fn, spec]) => ({ lang, fn, kind: spec.kind, implicit: spec.implicit === true, delegable: spec.delegable === true })))
  .sort((a, b) => a.lang.localeCompare(b.lang) || a.fn.localeCompare(b.fn));
// A permission list names only functions from `allowed`; null when it names
// anything else. A grant must name at least one; the owner's list may be empty
// (the connection is then unusable, its owner included).
const validPermissions = (allowed, permissions, { allowEmpty = false } = {}) => {
  if (!Array.isArray(permissions) || permissions.length > 50) return null;
  if (permissions.length === 0 && !allowEmpty) return null;
  const out = [];
  for (const p of permissions) {
    const lang = typeof p?.lang === "string" ? p.lang.replace(/^L/i, "").padStart(4, "0") : null;
    const fn = typeof p?.fn === "string" ? p.fn : null;
    if (!allowed.some(a => a.lang === lang && a.fn === fn)) return null;
    if (!out.some(o => o.lang === lang && o.fn === fn)) out.push({ lang, fn });
  }
  return out;
};

const grantView = g => ({
  grantId: g.grantId,
  recipientLabel: g.recipientLabel ?? null,
  pending: !g.recipientUid,
  permissions: g.permissions ?? [],
  expiresAt: g.expiresAt ?? null,
  createdAt: g.createdAt,
});

const validCredential = ({ key, secret }: { key?: unknown, secret?: unknown } = {}) =>
  typeof key === "string" && key.length > 0 && key.length <= 256 &&
  typeof secret === "string" && secret.length > 0 && secret.length <= 1024;

export const createConnectionManager = ({ connections, brokerAdmin, audit, grants = null, systemConnections = {}, enabledGated = new Set() }) => {
  // Enablement-gated functions (AUTHOR-01) are neither listed nor accepted in
  // an owner's list or a grant unless this deployment enables them.
  const available = backend => registered(backend)
    .filter(f => !isGatedFunction(f.lang, f.fn) || enabledGated.has(`${f.lang}:${f.fn}`));
  const grantable = backend => available(backend).filter(f => f.delegable);
  const deny = async (reason, record) => {
    await audit({ ...record, outcome: "denied", reason });
    throw new PolicyDenied(reason);
  };
  // A configured system connection is never shared: sharing it would hand its
  // preview authority to a named account outside the system preview path.
  const isSystemConnection = connectionId => Object.values(systemConnections).includes(connectionId);
  const requireConsole = (caller, record) =>
    caller?.role !== "console" ? deny("caller-not-entry-point", record) : null;
  const owned = async (user, connectionId, record) => {
    const connection = typeof connectionId === "string" ? await connections.get(connectionId) : null;
    if (!connection) return deny("connection-not-found", record);
    if (connection.ownerUid !== user.uid) return deny("not-owner", { ...record, ownerUid: connection.ownerUid });
    return connection;
  };

  return {
    async list({ caller, user }) {
      await requireConsole(caller, { event: "connection-list", uid: user?.uid });
      const rows = await connections.listByOwner(user.uid);
      // system marks a configured system connection: it signs system previews
      // only and is refused for invocations, so the console must not offer it
      // as a connection to save through.
      // ownerPermissions: what the owner allows themselves through it; null is
      // everything (every connection made before owners could narrow it).
      return rows.map(({ connectionId, backend, status, label, ownerPermissions = null }) =>
        ({ connectionId, backend, status, label, system: isSystemConnection(connectionId), ownerPermissions }));
    },

    async create({ caller, user, backend, label = null, credential }) {
      const record = { event: "connection-create", uid: user?.uid };
      await requireConsole(caller, record);
      if (!BACKENDS.has(backend)) return deny("unknown-backend", record);
      if (label !== null && (typeof label !== "string" || label.length > LABEL_MAX)) return deny("bad-request", record);
      if (!validCredential(credential)) return deny("bad-credential", record);
      const connectionId = `conn-${randomUUID()}`;
      await brokerAdmin.createSecret(connectionId, { ownerUid: user.uid, backend, key: credential.key, secret: credential.secret });
      await connections.put({ connectionId, ownerUid: user.uid, backend, status: "active", label, ownerPermissions: null });
      await audit({ ...record, connectionId, ownerUid: user.uid, outcome: "allowed" });
      return { connectionId, backend, status: "active", label, ownerPermissions: null };
    },

    async rotate({ caller, user, connectionId, credential }) {
      const record = { event: "connection-rotate", uid: user?.uid, connectionId };
      await requireConsole(caller, record);
      const connection = await owned(user, connectionId, record);
      if (!validCredential(credential)) return deny("bad-credential", record);
      try {
        await brokerAdmin.rotateSecret(connectionId, {
          ownerUid: connection.ownerUid,
          backend: connection.backend,
          key: credential.key,
          secret: credential.secret
        });
      } catch (e) {
        if (e instanceof BrokerConflict) return deny("provider-account-changed", record);
        throw e;
      }
      await audit({ ...record, ownerUid: user.uid, outcome: "allowed" });
      return { connectionId };
    },

    async disable({ caller, user, connectionId }) {
      const record = { event: "connection-disable", uid: user?.uid, connectionId };
      await requireConsole(caller, record);
      const connection = await owned(user, connectionId, record);
      await connections.put({ ...connection, status: "disabled" });
      await audit({ ...record, ownerUid: user.uid, outcome: "allowed" });
      return { connectionId, status: "disabled" };
    },

    async remove({ caller, user, connectionId }) {
      const record = { event: "connection-delete", uid: user?.uid, connectionId };
      await requireConsole(caller, record);
      await owned(user, connectionId, record);
      await connections.delete(connectionId);
      if (grants) {
        for (const g of await grants.listByConnection(connectionId)) await grants.delete(g.grantId);
      }
      await brokerAdmin.deleteSecret(connectionId);
      await audit({ ...record, ownerUid: user.uid, outcome: "allowed" });
      return { connectionId, deleted: true };
    },

    async shareable({ caller, user, connectionId }) {
      const record = { event: "grant-shareable", uid: user?.uid, connectionId };
      await requireConsole(caller, record);
      const connection = await owned(user, connectionId, record);
      return grantable(connection.backend).map(({ lang, fn, kind }) => ({ lang, fn, kind }));
    },

    // Every protected function on this connection's backend, by language: the
    // owner's list may name any of them, a grant the delegable ones.
    async functions({ caller, user, connectionId }) {
      const record = { event: "connection-functions", uid: user?.uid, connectionId };
      await requireConsole(caller, record);
      const connection = await owned(user, connectionId, record);
      return available(connection.backend);
    },

    // The owner narrows (or restores, with null) what they themselves may do
    // through their connection. Independent of grants: an owner may share a
    // function they don't use. Policy enforces it like a grant.
    async setOwnerPermissions({ caller, user, connectionId, permissions = null }) {
      const record = { event: "connection-owner-permissions", uid: user?.uid, connectionId };
      await requireConsole(caller, record);
      const connection = await owned(user, connectionId, record);
      if (isSystemConnection(connectionId)) return deny("system-connection", record);
      let ownerPermissions = null;
      if (permissions !== null) {
        ownerPermissions = validPermissions(available(connection.backend), permissions, { allowEmpty: true });
        if (!ownerPermissions) return deny("bad-permissions", record);
      }
      await connections.put({ ...connection, ownerPermissions });
      await audit({ ...record, ownerUid: user.uid, outcome: "allowed" });
      return { connectionId, ownerPermissions };
    },

    async share({
      caller, user, connectionId, recipientUid = null, recipientEmailHash = null, recipientLabel = null,
      permissions = null, expiresAt = null
    }) {
      const record = { event: "grant-create", uid: user?.uid, connectionId };
      await requireConsole(caller, record);
      if (!grants) return deny("unavailable", record);
      const connection = await owned(user, connectionId, record);
      if (isSystemConnection(connectionId)) return deny("system-connection", record);
      if (connection.status !== "active") return deny("connection-disabled", record);
      if ((recipientUid === null) === (recipientEmailHash === null)) return deny("bad-request", record);
      if (recipientUid !== null && !ID_RE.test(recipientUid)) return deny("bad-request", record);
      if (recipientEmailHash !== null && !HASH_RE.test(recipientEmailHash)) return deny("bad-request", record);
      if (recipientLabel !== null && (typeof recipientLabel !== "string" || recipientLabel.length > 200)) return deny("bad-request", record);
      if (expiresAt !== null && !(typeof expiresAt === "string" && Date.parse(expiresAt) > Date.now())) return deny("bad-request", record);
      if (recipientUid === user.uid) return deny("self-grant", record);
      const granted = validPermissions(grantable(connection.backend), permissions);
      if (!granted) return deny("bad-permissions", record);
      const grant = {
        grantId: grantIdFor({ connectionId, recipientUid, recipientEmailHash }),
        connectionId,
        ownerUid: user.uid,
        recipientUid,
        recipientEmailHash,
        recipientLabel,
        permissions: granted,
        expiresAt,
        createdAt: new Date().toISOString(),
      };
      await grants.put(grant);
      await audit({ ...record, ownerUid: user.uid, outcome: "allowed" });
      return grantView(grant);
    },

    async grants({ caller, user, connectionId }) {
      const record = { event: "grant-list", uid: user?.uid, connectionId };
      await requireConsole(caller, record);
      if (!grants) return [];
      await owned(user, connectionId, record);
      return (await grants.listByConnection(connectionId)).filter(g => !isExpired(g)).map(grantView);
    },

    async update({ caller, user, connectionId, grantId, permissions = null, expiresAt = null }) {
      const record = { event: "grant-update", uid: user?.uid, connectionId };
      await requireConsole(caller, record);
      if (!grants) return deny("unavailable", record);
      const connection = await owned(user, connectionId, record);
      if (isSystemConnection(connectionId)) return deny("system-connection", record);
      const grant = typeof grantId === "string" ? await grants.get(grantId) : null;
      if (!grant || grant.connectionId !== connectionId) return deny("grant-not-found", record);
      if (expiresAt !== null && !(typeof expiresAt === "string" && Date.parse(expiresAt) > Date.now())) return deny("bad-request", record);
      const granted = validPermissions(grantable(connection.backend), permissions);
      if (!granted) return deny("bad-permissions", record);
      const updated = {
        ...grant,
        permissions: granted,
        expiresAt,
        updatedAt: new Date().toISOString(),
      };
      await grants.put(updated);
      await audit({ ...record, ownerUid: user.uid, outcome: "allowed" });
      return grantView(updated);
    },

    async revoke({ caller, user, connectionId, grantId }) {
      const record = { event: "grant-revoke", uid: user?.uid, connectionId };
      await requireConsole(caller, record);
      if (!grants) return deny("unavailable", record);
      await owned(user, connectionId, record);
      const grant = typeof grantId === "string" ? await grants.get(grantId) : null;
      if (!grant || grant.connectionId !== connectionId) return deny("grant-not-found", record);
      await grants.delete(grantId);
      await audit({ ...record, ownerUid: user.uid, outcome: "allowed" });
      return { grantId, revoked: true };
    },

    async shared({ caller, user }) {
      await requireConsole(caller, { event: "grant-shared", uid: user?.uid });
      if (!grants) return [];
      const rows = [];
      for (const g of await grants.listByRecipient(user.uid)) {
        if (isExpired(g)) continue;
        const c = await connections.get(g.connectionId);
        if (!c || c.ownerUid !== g.ownerUid) continue;
        rows.push({
          connectionId: c.connectionId,
          backend: c.backend,
          status: c.status,
          label: c.label ?? null,
          // Who shared it: the recipient should know whose credential they
          // are using. The owner chose to share with them, so this reveals
          // nothing the owner didn't.
          ownerUid: c.ownerUid,
          permissions: g.permissions ?? [],
          expiresAt: g.expiresAt ?? null,
        });
      }
      return rows;
    },

    async leave({ caller, user, connectionId }) {
      const record = { event: "grant-leave", uid: user?.uid, connectionId };
      await requireConsole(caller, record);
      if (!grants || typeof connectionId !== "string") return deny("bad-request", record);
      const grantId = grantIdFor({ connectionId, recipientUid: user.uid });
      if (!(await grants.get(grantId))) return deny("grant-not-found", record);
      await grants.delete(grantId);
      await audit({ ...record, outcome: "allowed" });
      return { connectionId, left: true };
    },

    // The console reports the hashes of the caller's verified emails; pending
    // grants for them become grants to this account.
    async claim({ caller, user, emailHashes }) {
      const record = { event: "grant-claim", uid: user?.uid };
      await requireConsole(caller, record);
      if (!grants) return { claimed: 0 };
      if (!Array.isArray(emailHashes) || emailHashes.length > 20 || !emailHashes.every(h => HASH_RE.test(h))) {
        return deny("bad-request", record);
      }
      let claimed = 0;
      for (const g of await grants.listPendingByEmailHash(emailHashes)) {
        await grants.delete(g.grantId);
        if (g.ownerUid === user.uid || isExpired(g)) continue;
        await grants.put({
          ...g,
          grantId: grantIdFor({ connectionId: g.connectionId, recipientUid: user.uid }),
          recipientUid: user.uid,
          recipientEmailHash: null,
        });
        claimed++;
      }
      if (claimed) await audit({ ...record, outcome: "allowed", reason: `claimed:${claimed}` });
      return { claimed };
    },
  };
};
