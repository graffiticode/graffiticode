import { UnauthenticatedError } from "@graffiticode/common/errors";
import { createStorers } from "../storage/index.js";
import { cleanUpFirebase } from "../testing/firebase.js";
import { buildApiKeyService } from "./api-key.js";

describe("services/api-key", () => {
  let apiKeyService;

  beforeEach(() => {
    const storers = createStorers();
    apiKeyService = buildApiKeyService(storers);
  });

  afterEach(async () => {
    await cleanUpFirebase();
  });

  it("should throw UnauthenticatedError is apiKey does not exist", async () => {
    const apiKey = "does-not-exist";

    await expect(apiKeyService.authenticate({ apiKey })).rejects.toThrow(UnauthenticatedError);
  });

  it("should authenticate valid api-key", async () => {
    const uid = "abc123";
    const { token: apiKey } = await apiKeyService.create({ uid });

    const authContext = await apiKeyService.authenticate({ apiKey });

    expect(authContext).toHaveProperty("uid", uid);
    expect(authContext).toHaveProperty("additionalClaims.apiKey", true);
  });
});
