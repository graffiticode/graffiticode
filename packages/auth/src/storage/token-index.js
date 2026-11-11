import { createHash } from "node:crypto";

// Index documents that find a record by a secret token (an API key, a refresh
// token, an OAuth access or refresh token) are named by the token's SHA-256,
// never by the token. A document's name isn't secret: Firestore's audit logs,
// exports and the console all show it.
//
// Entries written before this were named by the raw token. They are still
// found, and each is moved to its hashed name when it is (best effort; auth
// runs as auth-run, which may delete). Removals delete both names.

export const hashedTokenId = token => `h:${createHash("sha256").update(String(token)).digest("hex")}`;

// `base` is the index collection, e.g. "api-keys/-indexes-/token-to-id".
export const tokenIndexRef = (db, base, token) => db.doc(`${base}/${hashedTokenId(token)}`);
const legacyTokenIndexRef = (db, base, token) => db.doc(`${base}/${token}`);

// The index entry's data for `token`, or null.
export const readTokenIndex = async (db, base, token) => {
  const hashed = tokenIndexRef(db, base, token);
  const found = await hashed.get();
  if (found.exists) return found.data();
  const legacy = legacyTokenIndexRef(db, base, token);
  const old = await legacy.get();
  if (!old.exists) return null;
  const data = old.data();
  try {
    await db.runTransaction(async t => {
      const [stillOld, already] = await Promise.all([t.get(legacy), t.get(hashed)]);
      if (!stillOld.exists) return;
      if (!already.exists) t.create(hashed, stillOld.data());
      t.delete(legacy);
    });
  } catch (err) {
    console.warn(`token index: could not move a legacy entry in ${base}: ${err.message}`);
  }
  return data;
};

// Deletes both names of `token`'s index entry in `writer` (a batch or a
// transaction): writes 2 documents.
export const deleteTokenIndex = (writer, db, base, token) => {
  writer.delete(tokenIndexRef(db, base, token));
  writer.delete(legacyTokenIndexRef(db, base, token));
  return writer;
};
