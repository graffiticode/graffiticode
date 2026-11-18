/* eslint-disable camelcase */
// The OAuth-store migration contract's storage (oauth-migration.js), against
// the Firestore emulator. The contract's own acceptance suite lives in
// graffiticode-app (packages/core/src/oauth/legacy-contract-suite.ts) and runs
// against this service over HTTP; these cover what it can't reach.
import { createHash } from "node:crypto";
import { NotFoundError, UnavailableError } from "@graffiticode/common/errors";
import { getFirestore } from "../firebase.js";
import { cleanUpFirebase } from "../testing/firebase.js";
import { buildOAuthFlowStorer } from "./oauth-flow.js";
import { buildOAuthMigrationStorer, MigrationFencedError, tokenKey, withMarks } from "./oauth-migration.js";
import { buildOAuthTokenStorer } from "./oauth-tokens.js";

const sha256 = v => createHash("sha256").update(String(v)).digest("hex");
const token = (n, over = {}) => ({
  access_token: `at-${n}`,
  refresh_token: `rt-${n}`,
  firebase_id_token: `fid-${n}`,
  firebase_refresh_token: `frt-${n}`,
  firebase_token_expires_at: 1,
  client_id: `client-${n}`,
  client_name: "C",
  scope: "graffiticode",
  resource: "https://mcp.example/mcp",
  ...over,
});

describe("storage/oauth-migration", () => {
  let migration;
  let tokens;
  let codes;
  beforeEach(() => {
    migration = buildOAuthMigrationStorer({ pageSize: 2 });
    tokens = buildOAuthTokenStorer();
    codes = buildOAuthFlowStorer("oauth-codes");
  });
  afterEach(cleanUpFirebase);

  it("seals only once fenced; both are one-way and idempotent", async () => {
    await expect(migration.seal("graffiticode")).rejects.toThrow(/fenced before/);
    await migration.fence("graffiticode");
    await migration.fence("graffiticode");
    await migration.seal("graffiticode");
    await migration.seal("graffiticode");
    expect(await migration.status("graffiticode")).toEqual({ contract: 1, fenced: true, sealed: true });
  });

  it("an installation other than Graffiticode has no records here", async () => {
    await tokens.create("link-1", token(1));
    await migration.fence("example");
    expect(await migration.status("example")).toEqual({ contract: 1, fenced: true, sealed: false });
    expect(await migration.status("graffiticode")).toEqual({ contract: 1, fenced: false, sealed: false });
    expect(await migration.markMigrated("example", tokenKey(token(1)), "import", "c")).toEqual({ outcome: "refused", reason: "absent" });
    expect(await migration.inventory("example", null)).toEqual({ records: [], next: null });
    // Fencing another installation doesn't fence Graffiticode's records.
    await expect(tokens.create("link-2", token(2))).resolves.toBeTruthy();
  });

  it("the fence refuses rotation atomically: the old token stays", async () => {
    await tokens.create("link-1", token(1));
    await migration.fence("graffiticode");
    await expect(tokens.rotate("rt-1", token(2))).rejects.toThrow(MigrationFencedError);
    expect(await tokens.findByRefreshToken("rt-1")).toMatchObject({ access_token: "at-1" });
    expect(await tokens.findByRefreshToken("rt-2")).toBeNull();
  });

  it("unfenced rotation replaces the token in one step", async () => {
    await tokens.create("link-1", token(1));
    const next = await tokens.rotate("rt-1", token(2));
    expect(next).toMatchObject({ link_id: "link-1", access_token: "at-2" });
    expect(await tokens.findByRefreshToken("rt-1")).toBeNull();
    expect(await tokens.findByAccessToken("at-2")).toMatchObject({ refresh_token: "rt-2" });
    await expect(tokens.rotate("rt-1", token(3))).rejects.toThrow(NotFoundError);
  });

  it("a token without a refresh token is keyed by its access token", async () => {
    const db = getFirestore();
    // Written directly: the create route requires a refresh token, older entries may lack one.
    await db.doc("oauth-links/link-9/tokens/t9").set({ ...token(9), refresh_token: null });
    await db.doc(`oauth-links/-indexes-/access-token/h:${sha256("at-9")}`).set({ link_id: "link-9", token_id: "t9" });
    await migration.fence("graffiticode");
    expect(await migration.markMigrated("graffiticode", sha256("at-9"), "import", "c9")).toEqual({ outcome: "applied" });
  });

  it("a raw-indexed token: no definite answer until the fence's repair pass completes, then found by its key", async () => {
    const db = getFirestore();
    const rawIndexed = async (n, link) => {
      await db.doc(`oauth-links/${link}/tokens/t${n}`).set(token(n));
      await db.doc(`oauth-links/-indexes-/refresh-token/rt-${n}`).set({ link_id: link, token_id: `t${n}` });
      await db.doc(`oauth-links/-indexes-/access-token/at-${n}`).set({ link_id: link, token_id: `t${n}` });
    };
    await rawIndexed(5, "link-5");
    expect(await tokens.findByRefreshToken("rt-5")).toMatchObject({ access_token: "at-5" }); // ordinary lookup finds it
    // A hashed entry that names another live token makes the pass fail.
    await tokens.create("link-6", token(6));
    await rawIndexed(7, "link-7");
    await db.doc(`oauth-links/-indexes-/access-token/h:${sha256("at-7")}`).set({ link_id: "link-6", token_id: (await tokens.findByAccessToken("at-6")).id });
    await expect(migration.fence("graffiticode")).rejects.toThrow(/names another token/);
    expect(await migration.status("graffiticode")).toEqual({ contract: 1, fenced: true, sealed: false });
    // Fenced, index not ready: unknown, never absent, never applied on a guess.
    await expect(migration.markMigrated("graffiticode", tokenKey(token(5)), "import", "c5")).rejects.toThrow(UnavailableError);
    await expect(migration.revoke("graffiticode", tokenKey(token(5)))).rejects.toThrow(UnavailableError);
    expect((await tokens.findByRefreshToken("rt-5")).revoked_at).toBeUndefined();
    // Repaired: fencing again re-runs the pass, which now completes.
    await db.doc(`oauth-links/-indexes-/access-token/h:${sha256("at-7")}`).delete();
    await migration.fence("graffiticode");
    expect((await db.doc("oauth-migration/graffiticode").get()).data()).toMatchObject({ index_ready: true, index_repair: { tokens: 3 } });
    expect(await migration.markMigrated("graffiticode", tokenKey(token(5)), "import", "c5")).toEqual({ outcome: "applied" });
    expect(await migration.revoke("graffiticode", tokenKey(token(7)))).toEqual({ outcome: "applied" });
    expect(typeof (await tokens.findByRefreshToken("rt-7")).revoked_at).toBe("number");
  });

  it("a live token whose refresh token no index reaches: keyed, migrated and revoked by its access token, never given its refresh token back", async () => {
    const db = getFirestore();
    // Hashed access entry (live), raw access entry (repaired by the fence), no refresh entry for either.
    await db.doc("oauth-links/link-3/tokens/t3").set(token(3));
    await db.doc(`oauth-links/-indexes-/access-token/h:${sha256("at-3")}`).set({ link_id: "link-3", token_id: "t3" });
    await db.doc("oauth-links/link-4/tokens/t4").set(token(4));
    await db.doc("oauth-links/-indexes-/access-token/at-4").set({ link_id: "link-4", token_id: "t4" });
    for (const n of [3, 4]) {
      // Usable by its access token, as the contract presents it: no refresh token.
      expect(await tokens.findByAccessToken(`at-${n}`)).toMatchObject({ access_token: `at-${n}`, refresh_token: null });
      expect(await tokens.findByRefreshToken(`rt-${n}`)).toBeNull();
    }
    await expect(migration.inventory("graffiticode", null)).rejects.toThrow(UnavailableError);
    await migration.fence("graffiticode");
    expect((await db.doc("oauth-migration/graffiticode").get()).data().index_ready).toBe(true);
    // Not dropped: listed under its access token's key, without the refresh token.
    let records = [];
    let cursor = null;
    do {
      const page = await migration.inventory("graffiticode", cursor);
      records = records.concat(page.records);
      cursor = page.next;
    } while (cursor);
    const listed = Object.fromEntries(records.filter(r => r.kind === "token").map(r => [r.token.access_token, r]));
    for (const n of [3, 4]) {
      expect(listed[`at-${n}`]).toMatchObject({ key: sha256(`at-${n}`), token: { refresh_token: null, revoked: false, migration: null } });
    }
    // Found by that key; the refresh token's hash names nothing usable.
    expect(await migration.markMigrated("graffiticode", sha256("rt-3"), "import", "c3")).toEqual({ outcome: "refused", reason: "absent" });
    expect(await migration.markMigrated("graffiticode", sha256("at-3"), "import", "c3")).toEqual({ outcome: "applied" });
    expect((await db.doc("oauth-links/link-3/tokens/t3").get()).data().migration).toMatchObject({ mode: "import", claim_id: "c3" });
    expect(await migration.revoke("graffiticode", sha256("at-4"))).toEqual({ outcome: "applied" });
    expect(typeof (await db.doc("oauth-links/link-4/tokens/t4").get()).data().revoked_at).toBe("number");
    // Repair moved the access entry only: the refresh token stays unusable.
    expect(await tokens.findByRefreshToken("rt-4")).toBeNull();
  });

  it("a live token whose access token no index reaches: flagged access_usable false everywhere, found by its refresh key", async () => {
    const db = getFirestore();
    await db.doc("oauth-links/link-2/tokens/t2").set(token(2));
    await db.doc(`oauth-links/-indexes-/refresh-token/h:${sha256("rt-2")}`).set({ link_id: "link-2", token_id: "t2" });
    expect(await tokens.findByAccessToken("at-2")).toBeNull();
    expect(withMarks(await tokens.findByRefreshToken("rt-2"))).toMatchObject({ access_token: "at-2", refresh_token: "rt-2", access_usable: false });
    await tokens.create("link-1", token(1)); // an ordinary token, for comparison
    await migration.fence("graffiticode");
    const { records } = await migration.inventory("graffiticode", null);
    expect(records.find(r => r.kind === "token" && r.token.access_token === "at-2")).toMatchObject({ key: sha256("rt-2"), token: { refresh_token: "rt-2", access_usable: false } });
    expect(await migration.markMigrated("graffiticode", sha256("rt-2"), "import", "c2")).toEqual({ outcome: "applied" });
    // An ordinary token is access-usable, both ways.
    expect(withMarks(await tokens.findByRefreshToken("rt-1")).access_usable).toBe(true);
    expect(withMarks(await tokens.findByAccessToken("at-1")).access_usable).toBe(true);
  });

  it("a token no index reaches isn't repaired into use, inventoried, or found", async () => {
    const db = getFirestore();
    await db.doc("oauth-links/link-8/tokens/t8").set(token(8));
    await migration.fence("graffiticode");
    expect(await tokens.findByRefreshToken("rt-8")).toBeNull();
    const { records } = await migration.inventory("graffiticode", null);
    expect(records.filter(r => r.kind === "token")).toEqual([]);
    expect(await migration.markMigrated("graffiticode", tokenKey(token(8)), "import", "c8")).toEqual({ outcome: "refused", reason: "absent" });
  });

  it("inventory pages through clients, then tokens, and only OAuth tokens", async () => {
    const db = getFirestore();
    for (const id of ["c1", "c2", "c3"]) await db.doc(`oauth-clients/${id}`).set({ client_id: id, updated_at: 1 });
    for (const n of [1, 2, 3]) await tokens.create(`link-${n}`, token(n));
    await db.doc("elsewhere/x/tokens/y").set({ access_token: "not-oauth" });
    await migration.fence("graffiticode");
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = await migration.inventory("graffiticode", cursor);
      seen.push(...page.records);
      cursor = page.next;
      pages++;
    } while (cursor);
    expect(pages).toBeGreaterThan(2);
    expect(seen.filter(r => r.kind === "client").map(r => r.key)).toEqual(["c1", "c2", "c3"]);
    expect(seen.find(r => r.kind === "client").client).toEqual({ client_id: "c1" });
    const toks = seen.filter(r => r.kind === "token");
    expect(toks.map(r => r.key).sort()).toEqual([1, 2, 3].map(n => tokenKey(token(n))).sort());
    expect(toks.every(r => r.token.revoked === false && r.token.migration === null)).toBe(true);
  });

  it("consume finds only live records: an expired code reads as absent", async () => {
    await codes.put("code-old", { code: "code-old", used: false, expires_at: Date.now() - 1 });
    await codes.put("code-new", { code: "code-new", used: false, expires_at: Date.now() + 60_000 });
    await migration.fence("graffiticode");
    expect(await migration.consume("graffiticode", "code", sha256("code-old"), "c")).toEqual({ outcome: "refused", reason: "absent" });
    expect(await migration.consume("graffiticode", "code", sha256("code-new"), "c")).toEqual({ outcome: "applied" });
    expect(await codes.get("code-new")).toMatchObject({ used: true, consumed_by: "c" });
  });

  it("revocation marks the token without deleting it, and reads report it", async () => {
    await tokens.create("link-1", token(1));
    await migration.fence("graffiticode");
    expect(await migration.revoke("graffiticode", tokenKey(token(1)))).toEqual({ outcome: "applied" });
    const read = withMarks(await tokens.findByAccessToken("at-1"));
    expect(read).toMatchObject({ access_token: "at-1", revoked: true, migration: null });
    expect("revoked_at" in read).toBe(false);
  });

  it("the seal refuses every migration operation", async () => {
    await tokens.create("link-1", token(1));
    await migration.fence("graffiticode");
    await migration.seal("graffiticode");
    const sealed = { outcome: "refused", reason: "sealed" };
    expect(await migration.revoke("graffiticode", tokenKey(token(1)))).toEqual(sealed);
    expect(await migration.markMigrated("graffiticode", tokenKey(token(1)), "import", "c")).toEqual(sealed);
    expect(await migration.consume("graffiticode", "code", sha256("x"), "c")).toEqual(sealed);
  });
});
