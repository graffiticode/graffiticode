import { NotFoundError } from "@graffiticode/common/errors";
import { cleanUpFirebase } from "../testing/firebase.js";
import { buildApiKeyStorer } from "./api-keys.js";

describe("storage/api-keys", () => {
  let storer;
  beforeEach(async () => {
    storer = buildApiKeyStorer();
  });

  afterEach(cleanUpFirebase);

  describe("storage/api-keys/findById", () => {
    it("should throw NotFoundError if does not exist", async () => {
      await expect(storer.findById("abc123")).rejects.toThrow(NotFoundError);
    });

    it("should be retrieved by id", async () => {
      const uid = "abc123";
      const { id } = await storer.create({ uid });

      const data = await storer.findById(id);

      expect(data).toHaveProperty("uid", uid);
    });
  });

  describe("storage/api-keys/findByToken", () => {
    it("should throw NotFoundError if does not exist", async () => {
      await expect(storer.findByToken("abc123")).rejects.toThrow(NotFoundError);
    });

    it("should be retrieved by token", async () => {
      const uid = "abc123";
      const { token } = await storer.create({ uid });

      const data = await storer.findByToken(token);

      expect(data).toHaveProperty("uid", uid);
    });
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
});
