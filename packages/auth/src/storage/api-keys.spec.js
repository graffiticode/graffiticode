import { InvalidArgumentError, NotFoundError } from "@graffiticode/common/errors";
import admin from "firebase-admin";
import { cleanUpFirebase } from "../testing/firebase.js";
import { buildApiKeyStorer } from "./api-keys.js";
import { getFirestore } from "../firebase.js";

const Timestamp = admin.firestore.Timestamp;

describe("storage/api-keys", () => {
  let storer;
  beforeEach(async () => {
    storer = buildApiKeyStorer();
  });

  afterEach(cleanUpFirebase);

  it("should throw NotFoundError if does not exist", async () => {
    await expect(storer.findById("abc123")).rejects.toThrow(NotFoundError);
  });

  it("should be retrieved by id", async () => {
    const uid = "abc123";
    const { id } = await storer.create({ uid });

    const data = await storer.findById(id);

    expect(data).toHaveProperty("id", id);
    expect(data).toHaveProperty("uid", uid);
    expect(data).toHaveProperty("createdAt");
  });

  it("should throw NotFoundError if does not exist", async () => {
    await expect(storer.findByToken("abc123")).rejects.toThrow(NotFoundError);
  });

  it("should be retrieved by token with another private collection", async () => {
    const uid = "abc123";
    const { id, token } = await storer.create({ uid });
    const db = getFirestore();
    await db.doc("refresh-tokens/abc123/private/key").set({ token });

    const data = await storer.findByToken(token);

    expect(data).toHaveProperty("id", id);
    expect(data).toHaveProperty("uid", uid);
    expect(data).toHaveProperty("createdAt");
  });

  it("should be retrieved by token", async () => {
    const uid = "abc123";
    const { id, token } = await storer.create({ uid });

    const data = await storer.findByToken(token);

    expect(data).toHaveProperty("id", id);
    expect(data).toHaveProperty("uid", uid);
    expect(data).toHaveProperty("createdAt");
  });

  it("should throw NotFoundError for delete api-key", async () => {
    const uid = "abc123";
    const { id } = await storer.create({ uid });
    await storer.removeById(id);

    await expect(storer.findById(id)).rejects.toThrow(NotFoundError);
  });

  it("should delete a non-existing api-key", async () => {
    await expect(storer.removeById("does-not-exist")).resolves.toBe();
  });

  describe("list", () => {
    const createApiKeys = async (uid, num) => {
      const apiKeys = [];
      for (let i = 0; i < num; i++) {
        apiKeys.push(await storer.create({ uid }));
      }
      return apiKeys;
    };

    const expectIdsAndUid = (actual, expectedApiKeys) => {
      expect(actual).toEqual(expectedApiKeys.map(({ id, uid }) =>
        ({ id, uid, createdAt: expect.any(Timestamp) })));
    };

    it("should return list of API keys", async () => {
      const uid = "abc123";
      const apiKeys = await createApiKeys(uid, 3);

      const actual = await storer.list({ uid });

      expectIdsAndUid(actual, apiKeys);
    });

    it("should return list of API keys for uid", async () => {
      const uid1 = "abc123";
      const uid2 = "def456";
      const apiKeys = await createApiKeys(uid1, 2);
      await createApiKeys(uid2, 1);

      const actual = await storer.list({ uid: uid1 });

      expectIdsAndUid(actual, apiKeys);
    });

    it("should return list of API keys with limit", async () => {
      const uid = "abc123";
      const apiKeys = await createApiKeys(uid, 7);

      const actual = await storer.list({ uid, limit: 5 });

      expectIdsAndUid(actual, apiKeys.slice(0, 5));
    });

    it("should return list of API keys with limit below 5", async () => {
      const uid = "abc123";
      const apiKeys = await createApiKeys(uid, 7);

      const actual = await storer.list({ uid, limit: 2 });

      expectIdsAndUid(actual, apiKeys.slice(0, 5));
    });

    it("should return list of API keys with default limit of 100", async () => {
      const uid = "abc123";
      const apiKeys = await createApiKeys(uid, 102);

      const actual = await storer.list({ uid });

      expectIdsAndUid(actual, apiKeys.slice(0, 100));
    });

    it("should return list of API keys starting after N time", async () => {
      const uid = "abc123";
      const apiKeys = await createApiKeys(uid, 7);
      const apiKey1 = await storer.findById(apiKeys[1].id);
      const createdAfterMillis = apiKey1.createdAt.toMillis();

      const actual = await storer.list({ uid, createdAfterMillis });

      expectIdsAndUid(actual, apiKeys.slice(2));
    });

    it("should throw if createdAfterMillis is negative", async () => {
      const uid = "abc123";
      await createApiKeys(uid, 7);

      await expect(storer.list({ uid, createdAfterMillis: -1 }))
        .rejects.toThrow(InvalidArgumentError);
    });
  });
});
