// Owner-side connection lifecycle, called by the console on behalf of a
// verified user. The credential passes through here to the broker (the only
// place it is stored, sealed) and is never stored, returned or logged by
// policy. Every change is audited as a lifecycle event.
//
//   list     the owner's connections (no secrets)
//   create   new connection: secret to the broker first, then the record, so a
//            record never exists without its credential
//   rotate   replace the secret; grants attach to the connection, so they
//            survive rotation. Owner, backend and provider account (the key)
//            are immutable; the broker refuses a change to any of them
//   disable  stop all use at the next snapshot or mint
//   remove   delete the record, its grants, then the secret
//
// Sharing (delegation), also called by the console for a verified user:
//   share        the owner grants a preset to an account, or to an email hash
//                until that person signs in (pending)
//   grants       the owner lists a connection's grants
//   revoke       the owner removes one; it stops the recipient's next call
//   shared       a recipient lists connections shared with them
//   leave        a recipient drops a grant
//   claim        a recipient turns pending grants for their emails into grants

import { randomUUID } from "node:crypto";
import { OPERATIONS, PROTECTED_FUNCTIONS } from "@graffiticode/common/protected-registry";
import { PolicyDenied } from "./policy.js";
import { grantIdFor, isExpired } from "./grants.js";
import { BrokerConflict } from "./broker-admin.js";

const BACKENDS = new Set(Object.values(OPERATIONS).map(op => op.backend));
const LABEL_MAX = 100;

const ID_RE = /^[A-Za-z0-9_:.-]{1,200}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

// What each preset grants against a backend: the registry's delegable
// functions of these kinds, in every language (Author signing is not
// delegable, so no preset reaches it). "publish" adds the right to publish.
const PRESETS = Object.freeze({
  preview: { kinds: ["sign", "read"], publish: false },
  save: { kinds: ["sign", "read", "write"], publish: false },
  publish: { kinds: ["sign", "read", "write"], publish: true },
});
const delegableFns = (backend, kinds) => [...new Set(
  Object.values(PROTECTED_FUNCTIONS).flatMap(fns => Object.entries(fns)
    .filter(([, spec]) => spec.backend === backend && spec.delegable === true && kinds.includes(spec.kind))
    .map(([fn]) => fn))
)].sort();

const grantView = g => ({
  grantId: g.grantId,
  recipientLabel: g.recipientLabel ?? null,
  pending: !g.recipientUid,
  preset: g.preset,
  expiresAt: g.expiresAt ?? null,
  createdAt: g.createdAt,
});

const validCredential = ({ key, secret } = {}) =>
  typeof key === "string" && key.length > 0 && key.length <= 256 &&
  typeof secret === "string" && secret.length > 0 && secret.length <= 1024;

export const createConnectionManager = ({ connections, brokerAdmin, audit, grants = null }) => {
  const deny = async (reason, record) => {
    await audit({ ...record, outcome: "denied", reason });
    throw new PolicyDenied(reason);
  };
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
      return rows.map(({ connectionId, backend, status, label }) => ({ connectionId, backend, status, label }));
    },

    async create({ caller, user, backend, label = null, credential }) {
      const record = { event: "connection-create", uid: user?.uid };
      await requireConsole(caller, record);
      if (!BACKENDS.has(backend)) return deny("unknown-backend", record);
      if (label !== null && (typeof label !== "string" || label.length > LABEL_MAX)) return deny("bad-request", record);
      if (!validCredential(credential)) return deny("bad-credential", record);
      const connectionId = `conn-${randomUUID()}`;
      await brokerAdmin.createSecret(connectionId, { ownerUid: user.uid, backend, key: credential.key, secret: credential.secret });
      await connections.put({ connectionId, ownerUid: user.uid, backend, status: "active", label });
      await audit({ ...record, connectionId, ownerUid: user.uid, outcome: "allowed" });
      return { connectionId, backend, status: "active", label };
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

    async share({ caller, user, connectionId, recipientUid = null, recipientEmailHash = null, recipientLabel = null, preset, expiresAt = null }) {
      const record = { event: "grant-create", uid: user?.uid, connectionId };
      await requireConsole(caller, record);
      if (!grants) return deny("unavailable", record);
      const connection = await owned(user, connectionId, record);
      if (connection.status !== "active") return deny("connection-disabled", record);
      if (!Object.prototype.hasOwnProperty.call(PRESETS, preset)) return deny("bad-request", record);
      if ((recipientUid === null) === (recipientEmailHash === null)) return deny("bad-request", record);
      if (recipientUid !== null && !ID_RE.test(recipientUid)) return deny("bad-request", record);
      if (recipientEmailHash !== null && !HASH_RE.test(recipientEmailHash)) return deny("bad-request", record);
      if (recipientLabel !== null && (typeof recipientLabel !== "string" || recipientLabel.length > 200)) return deny("bad-request", record);
      if (expiresAt !== null && !(typeof expiresAt === "string" && Date.parse(expiresAt) > Date.now())) return deny("bad-request", record);
      if (recipientUid === user.uid) return deny("self-grant", record);
      const { kinds, publish } = PRESETS[preset];
      const grant = {
        grantId: grantIdFor({ connectionId, recipientUid, recipientEmailHash }),
        connectionId,
        ownerUid: user.uid,
        recipientUid,
        recipientEmailHash,
        recipientLabel,
        preset,
        fns: delegableFns(connection.backend, kinds),
        publish,
        expiresAt,
        createdAt: new Date().toISOString(),
      };
      await grants.put(grant);
      await audit({ ...record, ownerUid: user.uid, outcome: "allowed", reason: preset });
      return grantView(grant);
    },

    async grants({ caller, user, connectionId }) {
      const record = { event: "grant-list", uid: user?.uid, connectionId };
      await requireConsole(caller, record);
      if (!grants) return [];
      await owned(user, connectionId, record);
      return (await grants.listByConnection(connectionId)).filter(g => !isExpired(g)).map(grantView);
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
        rows.push({ connectionId: c.connectionId, backend: c.backend, status: c.status, label: c.label ?? null, preset: g.preset, expiresAt: g.expiresAt ?? null });
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
