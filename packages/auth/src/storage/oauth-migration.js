/* eslint-disable camelcase */
// The OAuth-store migration contract, version 1 (graffiticode-app,
// packages/core/src/oauth/legacy-contract.ts, the source of truth; its
// acceptance suite is legacy-contract-suite.ts there). Each installation moves
// its OAuth records out of this store into its own database; this store stays
// the authority for what it still holds until then.
//
//   oauth-migration/<installation>  { fenced, fenced_at, sealed, sealed_at }
//
// The fence: once an installation is fenced, every ordinary write of its
// records is refused (MigrationFencedError, answered 409 migration_fenced).
// Each ordinary write runs in a transaction that reads this document
// (assertUnfenced), so none can commit after the fence does. The seal (only
// once fenced) refuses the migration operations too, revocation included. Both
// are one-way.
//
// Records written before installations carry none, and are Graffiticode's,
// the only installation that had any; other installations have none here.
//
// The migration operations, accepted only while fenced and unsealed:
//   consume(kind, hash, claim)       a code's or pending authorization's single
//                                    use: consumed_by on its document;
//   markMigrated(hash, mode, claim)  a token's single migration: migration on
//                                    its document;
//   revoke(hash)                     a token's revocation: revoked_at on its
//                                    document (it reads as revoked; nothing is
//                                    deleted).
// consume and markMigrated are compare-and-set: applied the first time and
// again for the same claim, refused for good otherwise. A token is named by
// its key: the SHA-256 of its refresh token, or of its access token when it
// has none (the index documents are named h:<that hash>, token-index.js).
//
// Index entries written before the hashing change are still named by the raw
// token until something moves them (token-index.js, best effort). A missing
// hashed entry therefore proves nothing. So fencing runs a full repair pass
// first (repairIndex): every entry still under its raw name gets its hashed
// name, each in its own transaction, and only a pass that completes without
// an error records index_ready. The fence stops every other write, so after
// that pass the hashed names are complete and stay so. Until then the token
// operations (markMigrated, revoke) answer UnavailableError (503, which the
// contract's callers retry): never absent, never applied on a guess. A failed
// pass leaves the fence set and the index not ready; fencing again re-runs it.
import { createHash } from "node:crypto";
import { ConflictError, UnavailableError } from "@graffiticode/common/errors";
import { FieldPath } from "firebase-admin/firestore";
import { getFirestore } from "../firebase.js";
import { tokenIndexRef } from "./token-index.js";

export const CONTRACT_VERSION = 1;
export const LEGACY_INSTALLATION = "graffiticode";
export const ACCESS_INDEX = "oauth-links/-indexes-/access-token";
export const REFRESH_INDEX = "oauth-links/-indexes-/refresh-token";
const FLOW_COLLECTIONS = { code: "oauth-codes", pending: "oauth-pending" };
const PAGE = 100;

export class MigrationFencedError extends Error {
  constructor(message = "The OAuth store is fenced for this installation's migration") {
    super(message);
    this.name = "MigrationFencedError";
  }
}

const sha256 = value => createHash("sha256").update(String(value)).digest("hex");
// A token record's key (the contract's tokenKey).
export const tokenKey = token => sha256(token.refresh_token || token.access_token);

const migrationRef = (db, installation) => db.doc(`oauth-migration/${installation}`);
const stateOf = snap => ({
  fenced: snap.exists && snap.data().fenced === true,
  sealed: snap.exists && snap.data().sealed === true,
  indexReady: snap.exists && snap.data().index_ready === true,
});

// Inside a transaction, before any of its writes: refuse an ordinary write of
// the legacy records once their installation is fenced.
export const assertUnfenced = async (tx, db = getFirestore()) => {
  if (stateOf(await tx.get(migrationRef(db, LEGACY_INSTALLATION))).fenced) throw new MigrationFencedError();
};
// The same check outside a transaction, to refuse early (before side effects).
export const checkUnfenced = async (db = getFirestore()) => {
  if (stateOf(await migrationRef(db, LEGACY_INSTALLATION).get()).fenced) throw new MigrationFencedError();
};

const applied = { outcome: "applied" };
const refused = reason => ({ outcome: "refused", reason });

// A token document by its key, inside a transaction: through the refresh-token
// index, or the access-token index for a token without a refresh token.
const tokenByKey = async (tx, db, key) => {
  for (const base of [REFRESH_INDEX, ACCESS_INDEX]) {
    const index = await tx.get(db.doc(`${base}/h:${key}`));
    if (!index.exists) continue;
    const { link_id, token_id } = index.data();
    const ref = db.doc(`oauth-links/${link_id}/tokens/${token_id}`);
    const snap = await tx.get(ref);
    if (!snap.exists) continue;
    const usable = await usableToken(r => tx.get(r), db, ref, snap.data());
    if (usable.key === key) return { ref, data: snap.data() };
  }
  return null;
};

// What of a stored token is usable today: each of its credentials counts only
// if its own hashed index entry reaches this very document (after the fence's
// repair pass, the hashed names are complete).
//   - A refresh token no index reaches can't be refreshed: the token is
//     presented without it, and its key (the contract's tokenKey of that
//     presentation) is its access token's hash.
//   - An access token no index reaches can't authenticate: the token is
//     presented with access_usable false, so an importer gives it a fresh
//     access token rather than reviving this one.
// A token neither credential reaches isn't usable at all.
export const usableToken = async (read, db, ref, data) => {
  const reaches = async (base, credential) => {
    if (!credential) return false;
    const entry = await read(db.doc(`${base}/h:${sha256(credential)}`));
    return entry.exists && `oauth-links/${entry.data().link_id}/tokens/${entry.data().token_id}` === ref.path;
  };
  const refresh = await reaches(REFRESH_INDEX, data.refresh_token);
  const access = await reaches(ACCESS_INDEX, data.access_token);
  const view = { ...(refresh ? data : { ...data, refresh_token: null }), access_usable: access };
  return { usable: refresh || access, view, key: tokenKey(view) };
};

// A token as the contract reports it: its fields, whether its access token is
// usable (access_usable, true unless shown otherwise), and its marks.
export const withMarks = token => {
  if (!token) return token;
  const { migration, revoked_at, ...rest } = token;
  return {
    access_usable: true,
    ...rest,
    revoked: typeof revoked_at === "number",
    migration: migration?.mode && migration?.claim_id ? { mode: migration.mode, claim_id: migration.claim_id } : null,
  };
};

export const buildOAuthMigrationStorer = ({ now = Date.now, pageSize = PAGE } = {}) => {
  const db = () => getFirestore();

  const status = async installation => {
    const s = stateOf(await migrationRef(db(), installation).get());
    return { contract: CONTRACT_VERSION, fenced: s.fenced, sealed: s.sealed };
  };

  // Fence, then (for the installation that has records here) repair the token
  // indexes; the fence is set first, so nothing writes while the pass runs. A
  // failed pass throws: the fence stays, the index isn't ready, and fencing
  // again re-runs the pass.
  const fence = async installation => {
    const ref = migrationRef(db(), installation);
    const state = await db().runTransaction(async tx => {
      const s = stateOf(await tx.get(ref));
      if (!s.fenced) tx.set(ref, { fenced: true, fenced_at: now() }, { merge: true });
      return s;
    });
    if (!state.indexReady) {
      const repaired = installation === LEGACY_INSTALLATION ? await repairIndex() : { tokens: 0, moved: 0 };
      await ref.set({ index_ready: true, index_ready_at: now(), index_repair: repaired }, { merge: true });
    }
    return { fenced: true };
  };

  // Every token's index entries under their hashed names, where they exist
  // only under the raw ones. Each entry moves in its own transaction (and a
  // concurrent read moving it too is fine: create-if-absent). An entry whose
  // hashed name points at another live token is an inconsistency the pass
  // refuses to paper over: it throws, and the index stays not ready.
  const repairIndex = async () => {
    let tokens = 0;
    let moved = 0;
    let cursor = null;
    for (;;) {
      let q = db().collectionGroup("tokens").orderBy(FieldPath.documentId()).limit(pageSize);
      if (cursor) q = q.startAfter(cursor);
      const page = await q.get();
      for (const d of page.docs) {
        if (!d.ref.path.startsWith("oauth-links/")) continue;
        const data = d.data();
        tokens++;
        for (const [base, token] of [[ACCESS_INDEX, data.access_token], [REFRESH_INDEX, data.refresh_token]]) {
          if (token && await moveEntry(base, token, d.ref)) moved++;
        }
      }
      if (page.size < pageSize) return { tokens, moved };
      cursor = page.docs.at(-1).ref.path;
    }
  };

  const moveEntry = (base, token, tokenRef) => db().runTransaction(async tx => {
    /** @type {import("firebase-admin/firestore").DocumentReference} */
    const hashed = tokenIndexRef(db(), base, token);
    const raw = db().doc(`${base}/${token}`);
    const h = await tx.get(hashed);
    const r = await tx.get(raw);
    const points = entry => entry.exists && `oauth-links/${entry.data().link_id}/tokens/${entry.data().token_id}` === tokenRef.path;
    if (h.exists) {
      if (points(h)) return false;
      const other = await tx.get(db().doc(`oauth-links/${h.data().link_id}/tokens/${h.data().token_id}`));
      if (other.exists) throw new Error(`index repair: ${base} entry for ${tokenRef.path} names another token (${other.ref.path})`);
    }
    // Only an entry that reaches this token today moves: a token no index
    // reaches isn't usable, and repair doesn't make it so.
    if (!points(r)) return false;
    tx.set(hashed, { link_id: tokenRef.parent.parent.id, token_id: tokenRef.id });
    return true;
  });

  const seal = async installation => {
    const ref = migrationRef(db(), installation);
    await db().runTransaction(async tx => {
      const snap = await tx.get(ref);
      const s = stateOf(snap);
      if (!s.fenced) throw new ConflictError("The installation must be fenced before it is sealed");
      if (s.sealed) return;
      tx.set(ref, { sealed: true, sealed_at: now() }, { merge: true });
    });
    return { sealed: true };
  };

  // Runs fn in a transaction once the installation is fenced and unsealed;
  // otherwise the refusal that says why.
  // `byKey`: the operation finds a token by its key, so it needs the repaired
  // index (or the answer is unknown: 503).
  const migrating = (installation, fn, { byKey = false } = {}) => db().runTransaction(async tx => {
    const s = stateOf(await tx.get(migrationRef(db(), installation)));
    if (!s.fenced) return refused("not_fenced");
    if (s.sealed) return refused("sealed");
    if (byKey && installation === LEGACY_INSTALLATION && !s.indexReady) {
      throw new UnavailableError("The token index is being repaired after the fence; retry");
    }
    return fn(tx);
  });

  const consume = (installation, kind, hash, claimId) => migrating(installation, async tx => {
    if (installation !== LEGACY_INSTALLATION) return refused("absent");
    // Codes and pending authorizations are keyed by the credential itself, and
    // live ten minutes: find the one whose key hashes to `hash` among those
    // not yet expired.
    const live = await tx.get(db().collection(FLOW_COLLECTIONS[kind]).where("expires_at", ">", now()));
    const doc = live.docs.find(d => sha256(d.id) === hash);
    if (!doc) return refused("absent");
    const record = doc.data();
    if (record.consumed_by === claimId) return applied;
    if (record.consumed_by || (kind === "code" && record.used === true)) return refused("consumed");
    tx.update(doc.ref, { consumed_by: claimId, consumed_at: now() });
    return applied;
  });

  const markMigrated = (installation, hash, mode, claimId) => migrating(installation, async tx => {
    if (installation !== LEGACY_INSTALLATION) return refused("absent");
    const token = await tokenByKey(tx, db(), hash);
    if (!token) return refused("absent");
    if (typeof token.data.revoked_at === "number") return refused("revoked");
    const m = token.data.migration;
    if (m?.claim_id) return m.claim_id === claimId ? applied : refused("claimed");
    tx.update(token.ref, { migration: { mode, claim_id: claimId, at: now() } });
    return applied;
  }, { byKey: true });

  const revoke = (installation, hash) => migrating(installation, async tx => {
    if (installation !== LEGACY_INSTALLATION) return applied;
    const token = await tokenByKey(tx, db(), hash);
    if (token && typeof token.data.revoked_at !== "number") tx.update(token.ref, { revoked_at: now() });
    return applied;
  }, { byKey: true });

  // The installation's clients, then its tokens (each with its marks), a page
  // at a time. Cursor: "c:<client id>" or "t:<token document path>". Each
  // token as usableToken presents it, under the key markMigrated finds it by:
  // a token no index reaches isn't usable, and isn't listed; a refresh token
  // no index reaches is presented as absent. Read-only, and only once the
  // fence's repair pass has made the hashed names complete.
  const inventory = async (installation, cursor) => {
    if (installation !== LEGACY_INSTALLATION) return { records: [], next: null };
    // What's usable is read from the hashed index names, complete only once
    // the fence's repair pass has run.
    if (!stateOf(await migrationRef(db(), installation).get()).indexReady) {
      throw new UnavailableError("The token index isn't repaired yet (it is, when the fence is set); retry");
    }
    const records = [];
    let phase = cursor?.startsWith("t:") ? "tokens" : "clients";
    if (phase === "clients") {
      let q = db().collection("oauth-clients").orderBy(FieldPath.documentId()).limit(pageSize);
      if (cursor?.startsWith("c:")) q = q.startAfter(cursor.slice(2));
      const page = await q.get();
      for (const d of page.docs) records.push({ kind: "client", key: d.id, client: stripFlow(d.data()) });
      if (page.size === pageSize) return { records, next: `c:${page.docs.at(-1).id}` };
      phase = "tokens";
    }
    let q = db().collectionGroup("tokens").orderBy(FieldPath.documentId()).limit(pageSize);
    if (cursor?.startsWith("t:")) q = q.startAfter(cursor.slice(2));
    const page = await q.get();
    for (const d of page.docs) {
      if (!d.ref.path.startsWith("oauth-links/")) continue;
      const data = d.data();
      if (!data.access_token) continue;
      const usable = await usableToken(r => r.get(), db(), d.ref, data);
      if (!usable.usable) continue;
      records.push({ kind: "token", key: usable.key, token: withMarks({ ...usable.view, id: d.id, link_id: d.ref.parent.parent.id }) });
    }
    return { records, next: page.size === pageSize ? `t:${page.docs.at(-1).ref.path}` : null };
  };

  return { status, fence, seal, consume, markMigrated, revoke, inventory };
};

// A flow record as stored, without this store's own bookkeeping.
/** @param {Record<string, any>} record */
const stripFlow = ({ updated_at: _u, ...rest }) => rest;
