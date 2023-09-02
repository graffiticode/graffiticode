import { UnauthenticatedError } from "@graffiticode/common/errors";
import { createStorers } from "../storage/index.js";
import { cleanUpFirebase } from "../testing/firebase.js";
import { buildApiKeyService } from "./api-key.js";

const uid = "abc123";

describe("services/api-key", () => {
  let apiKeyService;

  beforeEach(() => {
    const storers = createStorers();
    apiKeyService = buildApiKeyService(storers);
  });

  afterEach(async () => {
    await cleanUpFirebase();
  });

  it("should throw UnauthenticatedError if the api-key does not exist", async () => {
    const token = "does-not-exist";

    await expect(apiKeyService.authenticate({ token })).rejects.toThrow(UnauthenticatedError);
  });

  it("should authenticate valid api-key", async () => {
    const { token } = await apiKeyService.create({ uid });

    const authContext = await apiKeyService.authenticate({ token });

    expect(authContext).toHaveProperty("uid", uid);
    expect(authContext).toHaveProperty("additionalClaims.apiKey", true);
  });

  describe("authenticateWithId", () => {
    it("should throw UnauthenticatedError if the api-key does not exist", async () => {
      const { id } = await apiKeyService.create({ uid });
      const token = "does-not-exist";

      await expect(apiKeyService.authenticateWithId({ id, token })).rejects.toThrow(UnauthenticatedError);
    });

    it("should throw UnauthenticatedError if the id does not match the token's id", async () => {
      const { id } = await apiKeyService.create({ uid });
      const { token } = await apiKeyService.create({ uid });

      await expect(apiKeyService.authenticateWithId({ id, token })).rejects.toThrow(UnauthenticatedError);
    });

    it("should authenticate valid api-key", async () => {
      const { id, token } = await apiKeyService.create({ uid });

      const authContext = await apiKeyService.authenticateWithId({ id, token });

      expect(authContext).toHaveProperty("uid", uid);
      expect(authContext).toHaveProperty("additionalClaims.apiKey", true);
      expect(authContext).toHaveProperty("additionalClaims.apiKeyId", id);
    });
  });
});
