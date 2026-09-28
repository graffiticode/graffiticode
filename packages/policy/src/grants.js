// Grants: a connection's owner lets another account use some of its protected
// functions (delegation). A grant is authority, so policy holds it and checks
// it live at every invocation, snapshot and mint; revoking takes effect at the
// recipient's next call.
//
// A grant names its recipient by account (recipientUid) or, until that person
// signs in with the email the owner used, by a hash of that email
// (recipientEmailHash, pending). Claiming turns a pending grant into an account
// grant. The owner sees the same result either way, so sharing never reveals
// whether an email has an account.
//
//   { grantId, connectionId, ownerUid, recipientUid|null, recipientEmailHash|null,
//     recipientLabel, preset, permissions: [{ lang, fn }], publish, expiresAt|null, createdAt }
//
// Permissions are (language, function) pairs: a grant for L0176's
// save-to-itembank covers no other language's function of that name.
//
// Only functions the registry marks delegable can be granted; Author signing
// never is. A recipient cannot grant onwards.
//
// A store implements:
//   put(grant)                         create or replace by grantId
//   get(grantId) -> grant | null
//   listByConnection(connectionId) -> [grant]
//   listByRecipient(uid) -> [grant]
//   listPendingByEmailHash(hashes) -> [grant]
//   delete(grantId)

import { createHash } from "node:crypto";

export const grantIdFor = ({ connectionId, recipientUid = null, recipientEmailHash = null }) =>
  createHash("sha256")
    .update(JSON.stringify([connectionId, recipientUid ? `uid:${recipientUid}` : `email:${recipientEmailHash}`]))
    .digest("hex");

export const isExpired = (grant, now = Date.now()) =>
  Boolean(grant.expiresAt) && Date.parse(grant.expiresAt) <= now;

export const createMemoryGrantStore = (records = []) => {
  const byId = new Map(records.map(r => [r.grantId, { ...r }]));
  const all = () => [...byId.values()].map(r => ({ ...r }));
  return {
    async put(grant) {
      byId.set(grant.grantId, { ...grant });
    },
    async get(grantId) {
      const g = byId.get(grantId);
      return g ? { ...g } : null;
    },
    async listByConnection(connectionId) {
      return all().filter(g => g.connectionId === connectionId);
    },
    async listByRecipient(uid) {
      return all().filter(g => g.recipientUid === uid);
    },
    async listPendingByEmailHash(hashes) {
      const set = new Set(hashes);
      return all().filter(g => !g.recipientUid && set.has(g.recipientEmailHash));
    },
    async delete(grantId) {
      byId.delete(grantId);
    },
  };
};
