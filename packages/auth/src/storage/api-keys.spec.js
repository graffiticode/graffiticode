import { NotFoundError } from "@graffiticode/common/errors";
import { cleanUpFirebase } from "../testing/firebase.js";
import { buildApiKeyStorer } from "./api-keys.js";

describe("storage/api-keys", () => {
  let storer;
  beforeEach(async () => {
    storer = buildApiKeyStorer();
  });

  afterEach(cleanUpFirebase);

  it("should throw NotFoundError if api-key does not exist", async () => {
    await expect(storer.getApiKey("abc123")).rejects.toThrow(NotFoundError);
  });

  it("should create api-key that can retrieve data", async () => {
    const uid = "abc123";
    const apiKey = await storer.createApiKey({ uid });

    const data = await storer.getApiKey(apiKey);

    expect(data).toHaveProperty("uid", uid);
  });

  it("should throw NotFoundError for delete api-key", async () => {
    const uid = "abc123";
    const apiKey = await storer.createApiKey({ uid });
    await storer.deleteApiKey(apiKey);

    await expect(storer.getApiKey(apiKey)).rejects.toThrow(NotFoundError);
  });

  it("should delete a non-existing api-key", async () => {
    await expect(storer.deleteApiKey("does-not-exist")).resolves.toBe();
  });
});
