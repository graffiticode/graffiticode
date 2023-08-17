import { NotFoundError } from "@graffiticode/common/errors";
import { cleanUpFirebase } from "../testing/firebase.js";
import { buildRefreshTokenStorer } from "./refresh-tokens.js";

describe("storage/refresh-tokens", () => {
  let storer;
  beforeEach(async () => {
    storer = buildRefreshTokenStorer();
  });

  afterEach(cleanUpFirebase);

  it("should throw NotFoundError if refresh token does not exist", async () => {
    await expect(storer.getRefreshToken("abc123")).rejects.toThrow(NotFoundError);
  });

  it("should create refresh token that can retrieve data", async () => {
    const uid = "abc123";
    const { token } = await storer.createRefreshToken({ uid });

    const data = await storer.getRefreshToken(token);

    expect(data).toHaveProperty("uid", uid);
  });

  it("should throw NotFoundError for delete refresh token", async () => {
    const uid = "abc123";
    const { token } = await storer.createRefreshToken({ uid });
    await storer.deleteRefreshToken(token);

    await expect(storer.getRefreshToken(token)).rejects.toThrow(NotFoundError);
  });

  it("should delete a non-existing refresh token", async () => {
    await expect(storer.deleteRefreshToken("does-not-exist")).resolves.toBe();
  });

  it("should create refresh token that can retrieve additional claims data", async () => {
    const uid = "abc123";
    const { token } = await storer.createRefreshToken({ uid, additionalClaims: { apiKey: true } });

    const data = await storer.getRefreshToken(token);

    expect(data).toHaveProperty("uid", uid);
    expect(data).toHaveProperty("additionalClaims.apiKey", true);
  });
});
