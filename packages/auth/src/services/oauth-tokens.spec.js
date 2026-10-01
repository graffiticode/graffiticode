/* eslint-disable camelcase */
// Characterization tests: these pin the CURRENT behavior of
// services/oauth-tokens.js (written before the TypeScript migration), not a
// judgment of it. Storers are in-memory fakes that record calls, so these run
// without the emulator; storage/oauth-tokens.spec.js covers Firestore.
import { NotFoundError } from "@graffiticode/common/errors";
import { buildOAuthTokensService } from "./oauth-tokens.js";

const fakeStorers = ({ link = null, tokens = [] } = {}) => {
  const calls = [];
  const state = { link, tokens: [...tokens] };
  const oauthLinkStorer = {
    async findByProviderId(args) {
      calls.push(["link.findByProviderId", args]);
      if (!state.link) throw new NotFoundError("no link");
      return state.link;
    },
    async create(args) {
      calls.push(["link.create", args]);
      state.link = { id: "link-new", ...args };
      return state.link;
    },
  };
  const oauthTokenStorer = {
    async removeByClientId(linkId, clientId) { calls.push(["token.removeByClientId", linkId, clientId]); },
    async create(linkId, data) {
      calls.push(["token.create", linkId, data]);
      const token = { id: `t${state.tokens.length + 1}`, link_id: linkId, ...data };
      state.tokens.push(token);
      return token;
    },
    async findByAccessToken(accessToken) {
      calls.push(["token.findByAccessToken", accessToken]);
      return state.tokens.find(t => t.access_token === accessToken) ?? null;
    },
    async findByRefreshToken(refreshToken) {
      calls.push(["token.findByRefreshToken", refreshToken]);
      return state.tokens.find(t => t.refresh_token === refreshToken) ?? null;
    },
    async update(linkId, tokenId, updates) {
      calls.push(["token.update", linkId, tokenId, updates]);
      return { id: tokenId, link_id: linkId, ...updates };
    },
    async remove(linkId, tokenId) { calls.push(["token.remove", linkId, tokenId]); },
  };
  return { calls, oauthLinkStorer, oauthTokenStorer };
};

const tokenData = { access_token: "a1", refresh_token: "r1", client_id: "c1" };

describe("services/oauth-tokens", () => {
  describe("createToken", () => {
    it("uses an existing google link, replaces the client's token, then creates", async () => {
      const storers = fakeStorers({ link: { id: "link-1" } });
      const service = buildOAuthTokensService(storers);

      const token = await service.createToken({ providerId: "p1", email: "e@x", tokenData });

      expect(token).toEqual({ id: "t1", link_id: "link-1", ...tokenData });
      expect(storers.calls).toEqual([
        ["link.findByProviderId", { provider: "google", providerId: "p1" }],
        ["token.removeByClientId", "link-1", "c1"],
        ["token.create", "link-1", tokenData],
      ]);
    });

    it("creates a link with uid = providerId when none exists, defaulting email to ''", async () => {
      const storers = fakeStorers();
      const service = buildOAuthTokensService(storers);

      await service.createToken({ providerId: "p1", tokenData });

      expect(storers.calls[1]).toEqual(["link.create", { uid: "p1", provider: "google", providerId: "p1", email: "" }]);
      expect(storers.calls[3]).toEqual(["token.create", "link-new", tokenData]);
    });

    it("propagates link lookup errors other than NotFoundError", async () => {
      const storers = fakeStorers();
      storers.oauthLinkStorer.findByProviderId = async () => { throw new Error("db down"); };
      const service = buildOAuthTokensService(storers);
      await expect(service.createToken({ providerId: "p1", tokenData })).rejects.toThrow("db down");
    });

    it("ignores NotFoundError from removeByClientId but propagates others", async () => {
      const storers = fakeStorers({ link: { id: "link-1" } });
      storers.oauthTokenStorer.removeByClientId = async () => { throw new NotFoundError("none"); };
      const service = buildOAuthTokensService(storers);
      await expect(service.createToken({ providerId: "p1", tokenData })).resolves.toHaveProperty("id", "t1");

      storers.oauthTokenStorer.removeByClientId = async () => { throw new Error("boom"); };
      await expect(service.createToken({ providerId: "p1", tokenData })).rejects.toThrow("boom");
    });
  });

  it("getByAccessToken / getByRefreshToken return the storer result, including null", async () => {
    const storers = fakeStorers({ tokens: [{ id: "t1", link_id: "l", ...tokenData }] });
    const service = buildOAuthTokensService(storers);
    await expect(service.getByAccessToken("a1")).resolves.toHaveProperty("id", "t1");
    await expect(service.getByRefreshToken("r1")).resolves.toHaveProperty("id", "t1");
    await expect(service.getByAccessToken("nope")).resolves.toBeNull();
    await expect(service.getByRefreshToken("nope")).resolves.toBeNull();
  });

  describe("updateToken", () => {
    it("updates the token found by access token", async () => {
      const storers = fakeStorers({ tokens: [{ id: "t1", link_id: "l", ...tokenData }] });
      const service = buildOAuthTokensService(storers);
      await expect(service.updateToken("a1", { scope: "s" })).resolves.toEqual({ id: "t1", link_id: "l", scope: "s" });
      expect(storers.calls).toContainEqual(["token.update", "l", "t1", { scope: "s" }]);
    });

    it("throws NotFoundError('Token not found') for an unknown access token", async () => {
      const service = buildOAuthTokensService(fakeStorers());
      await expect(service.updateToken("nope", {})).rejects.toThrow(new NotFoundError("Token not found"));
    });
  });

  describe("deleteToken", () => {
    it("removes the token found by access token", async () => {
      const storers = fakeStorers({ tokens: [{ id: "t1", link_id: "l", ...tokenData }] });
      const service = buildOAuthTokensService(storers);
      await expect(service.deleteToken("a1")).resolves.toBeUndefined();
      expect(storers.calls).toContainEqual(["token.remove", "l", "t1"]);
    });

    it("throws NotFoundError for an unknown access token", async () => {
      const service = buildOAuthTokensService(fakeStorers());
      await expect(service.deleteToken("nope")).rejects.toThrow(NotFoundError);
    });
  });

  describe("rotateTokens", () => {
    it("removes the old token, then creates the new one under the same link", async () => {
      const storers = fakeStorers({ tokens: [{ id: "t1", link_id: "l", ...tokenData }] });
      const service = buildOAuthTokensService(storers);
      const next = { access_token: "a2", refresh_token: "r2", client_id: "c1" };

      await expect(service.rotateTokens("r1", next)).resolves.toEqual({ id: "t2", link_id: "l", ...next });
      expect(storers.calls.slice(1)).toEqual([
        ["token.remove", "l", "t1"],
        ["token.create", "l", next],
      ]);
    });

    it("throws NotFoundError for an unknown refresh token, creating nothing", async () => {
      const storers = fakeStorers();
      const service = buildOAuthTokensService(storers);
      await expect(service.rotateTokens("nope", tokenData)).rejects.toThrow(NotFoundError);
      expect(storers.calls.map(c => c[0])).toEqual(["token.findByRefreshToken"]);
    });
  });
});
