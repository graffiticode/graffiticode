/* eslint-disable camelcase */
// Characterization tests: these pin the CURRENT behavior of
// storage/oauth-tokens.js (written before the TypeScript migration), not a
// judgment of it. Runs against the Firestore emulator.
import { NotFoundError } from "@graffiticode/common/errors";
import { getFirestore } from "../firebase.js";
import { cleanUpFirebase } from "../testing/firebase.js";
import { buildOAuthTokenStorer } from "./oauth-tokens.js";

const tokenData = (n, overrides = {}) => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  firebase_id_token: `fid-${n}`,
  firebase_refresh_token: `frt-${n}`,
  firebase_token_expires_at: 1000 + n,
  client_id: `client-${n}`,
  client_name: `Client ${n}`,
  scope: "read",
  resource: "https://api.example",
  ...overrides,
});

describe("storage/oauth-tokens", () => {
  let storer;
  beforeEach(() => {
    storer = buildOAuthTokenStorer();
  });

  afterEach(cleanUpFirebase);

  describe("create", () => {
    it("returns the stored token with a generated id, link_id and created_at", async () => {
      const before = Date.now();
      const token = await storer.create("link-1", tokenData(1));
      expect(token).toEqual({
        id: expect.any(String),
        link_id: "link-1",
        ...tokenData(1),
        created_at: expect.any(Number),
      });
      expect(token.created_at).toBeGreaterThanOrEqual(before);
    });

    it("writes the token under the link plus access- and refresh-token indexes", async () => {
      const { id } = await storer.create("link-1", tokenData(1));
      const db = getFirestore();
      const doc = await db.doc(`oauth-links/link-1/tokens/${id}`).get();
      expect(doc.data()).toEqual({ ...tokenData(1), created_at: expect.any(Number) });
      expect(doc.data()).not.toHaveProperty("link_id");
      const byAccess = await db.doc("oauth-links/-indexes-/access-token/access-1").get();
      const byRefresh = await db.doc("oauth-links/-indexes-/refresh-token/refresh-1").get();
      expect(byAccess.data()).toEqual({ link_id: "link-1", token_id: id });
      expect(byRefresh.data()).toEqual({ link_id: "link-1", token_id: id });
    });

    it("fails, writing nothing, when an access token is already indexed", async () => {
      await storer.create("link-1", tokenData(1));
      await expect(storer.create("link-2", tokenData(2, { access_token: "access-1" }))).rejects.toThrow();
      const tokens = await getFirestore().collection("oauth-links/link-2/tokens").get();
      expect(tokens.empty).toBe(true);
      await expect(storer.findByRefreshToken("refresh-2")).resolves.toBeNull();
    });
  });

  describe("findByAccessToken / findByRefreshToken", () => {
    it("finds a token by either index", async () => {
      const created = await storer.create("link-1", tokenData(1));
      const expected = { ...tokenData(1), id: created.id, link_id: "link-1", created_at: created.created_at };
      await expect(storer.findByAccessToken("access-1")).resolves.toEqual(expected);
      await expect(storer.findByRefreshToken("refresh-1")).resolves.toEqual(expected);
    });

    it("returns null for an unknown token", async () => {
      await expect(storer.findByAccessToken("nope")).resolves.toBeNull();
      await expect(storer.findByRefreshToken("nope")).resolves.toBeNull();
    });

    it("returns null when the index points at a missing token", async () => {
      const { id } = await storer.create("link-1", tokenData(1));
      await getFirestore().doc(`oauth-links/link-1/tokens/${id}`).delete();
      await expect(storer.findByAccessToken("access-1")).resolves.toBeNull();
      await expect(storer.findByRefreshToken("refresh-1")).resolves.toBeNull();
    });
  });

  describe("update", () => {
    it("merges the updates and returns the full token", async () => {
      const { id, created_at } = await storer.create("link-1", tokenData(1));
      const updated = await storer.update("link-1", id, { firebase_id_token: "fid-new" });
      expect(updated).toEqual({ ...tokenData(1), id, link_id: "link-1", created_at, firebase_id_token: "fid-new" });
    });

    it("does not re-index when access_token is updated", async () => {
      const { id } = await storer.create("link-1", tokenData(1));
      await storer.update("link-1", id, { access_token: "access-new" });
      await expect(storer.findByAccessToken("access-new")).resolves.toBeNull();
      await expect(storer.findByAccessToken("access-1")).resolves.toHaveProperty("access_token", "access-new");
    });

    it("throws NotFoundError('Token not found') for a missing token", async () => {
      await expect(storer.update("link-1", "nope", {})).rejects.toThrow(new NotFoundError("Token not found"));
    });
  });

  describe("remove", () => {
    it("deletes the token and both indexes", async () => {
      const { id } = await storer.create("link-1", tokenData(1));
      await expect(storer.remove("link-1", id)).resolves.toBeUndefined();
      await expect(storer.findByAccessToken("access-1")).resolves.toBeNull();
      await expect(storer.findByRefreshToken("refresh-1")).resolves.toBeNull();
      const db = getFirestore();
      expect((await db.doc("oauth-links/-indexes-/access-token/access-1").get()).exists).toBe(false);
      expect((await db.doc("oauth-links/-indexes-/refresh-token/refresh-1").get()).exists).toBe(false);
    });

    it("throws NotFoundError for a missing token", async () => {
      await expect(storer.remove("link-1", "nope")).rejects.toThrow(new NotFoundError("Token not found"));
    });
  });

  describe("removeByClientId", () => {
    it("deletes one token for that client, with its indexes", async () => {
      await storer.create("link-1", tokenData(1));
      const keep = await storer.create("link-1", tokenData(2));
      await expect(storer.removeByClientId("link-1", "client-1")).resolves.toBeUndefined();
      await expect(storer.findByAccessToken("access-1")).resolves.toBeNull();
      await expect(storer.findByRefreshToken("refresh-1")).resolves.toBeNull();
      await expect(storer.findByAccessToken("access-2")).resolves.toHaveProperty("id", keep.id);
    });

    it("deletes only one token when a client has several", async () => {
      await storer.create("link-1", tokenData(1));
      await storer.create("link-1", tokenData(2, { client_id: "client-1" }));
      await storer.removeByClientId("link-1", "client-1");
      await expect(storer.listByLinkId("link-1")).resolves.toHaveLength(1);
    });

    it("does nothing when the client has no token", async () => {
      await storer.create("link-1", tokenData(1));
      await expect(storer.removeByClientId("link-1", "other")).resolves.toBeUndefined();
      await expect(storer.removeByClientId("link-2", "client-1")).resolves.toBeUndefined();
      await expect(storer.listByLinkId("link-1")).resolves.toHaveLength(1);
    });
  });

  describe("listByLinkId", () => {
    it("lists a link's tokens newest first", async () => {
      const first = await storer.create("link-1", tokenData(1));
      await new Promise(resolve => setTimeout(resolve, 5));
      const second = await storer.create("link-1", tokenData(2));
      await storer.create("link-2", tokenData(3));

      const tokens = await storer.listByLinkId("link-1");

      expect(tokens.map(t => t.id)).toEqual([second.id, first.id]);
      expect(tokens[0]).toEqual({ ...tokenData(2), id: second.id, link_id: "link-1", created_at: second.created_at });
    });

    it("returns [] for a link with no tokens", async () => {
      await expect(storer.listByLinkId("link-1")).resolves.toEqual([]);
    });
  });
});
