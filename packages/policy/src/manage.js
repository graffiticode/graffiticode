// Owner-side connection lifecycle, called by the console on behalf of a
// verified user. The credential passes through here to the broker (the only
// place it is stored, sealed) and is never stored, returned or logged by
// policy. Every change is audited as a lifecycle event.
//
//   list     the owner's connections (no secrets)
//   create   new connection: secret to the broker first, then the record, so a
//            record never exists without its credential
//   rotate   replace the secret; grants attach to the connection, so they
//            survive rotation
//   disable  stop all use at the next snapshot or mint
//   remove   delete the record, then the secret

import { randomUUID } from "node:crypto";
import { OPERATIONS } from "@graffiticode/common/protected-registry";
import { PolicyDenied } from "./policy.js";

const BACKENDS = new Set(Object.values(OPERATIONS).map(op => op.backend));
const LABEL_MAX = 100;

const validCredential = ({ key, secret } = {}) =>
  typeof key === "string" && key.length > 0 && key.length <= 256 &&
  typeof secret === "string" && secret.length > 0 && secret.length <= 1024;

export const createConnectionManager = ({ connections, brokerAdmin, audit }) => {
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
      await brokerAdmin.putSecret(connectionId, { key: credential.key, secret: credential.secret });
      await connections.put({ connectionId, ownerUid: user.uid, backend, status: "active", label });
      await audit({ ...record, connectionId, ownerUid: user.uid, outcome: "allowed" });
      return { connectionId, backend, status: "active", label };
    },

    async rotate({ caller, user, connectionId, credential }) {
      const record = { event: "connection-rotate", uid: user?.uid, connectionId };
      await requireConsole(caller, record);
      await owned(user, connectionId, record);
      if (!validCredential(credential)) return deny("bad-credential", record);
      await brokerAdmin.putSecret(connectionId, { key: credential.key, secret: credential.secret });
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
      await brokerAdmin.deleteSecret(connectionId);
      await audit({ ...record, ownerUid: user.uid, outcome: "allowed" });
      return { connectionId, deleted: true };
    },
  };
};
