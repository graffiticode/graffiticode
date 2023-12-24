import { InvalidArgumentError, UnauthenticatedError } from "@graffiticode/common/errors";
import admin from "firebase-admin";
import { createStorers } from "../storage/index.js";
import { cleanUpFirebase } from "../testing/firebase.js";
import { buildApiKeyService } from "./api-key.js";

const Timestamp = admin.firestore.Timestamp;
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

  describe("list", () => {
    const createApiKeys = async (uid, num) => {
      const apiKeys = [];
      for (let i = 0; i < num; i++) {
        apiKeys.push(await apiKeyService.create({ uid }));
      }
      return apiKeys;
    };

    const expectApiKeys = (actual, expectedApiKeys) => {
      expect(actual).toHaveProperty(
        "apiKeys",
        expectedApiKeys.map(({ id, uid }) => ({ id, uid, createdAt: expect.any(Timestamp) }))
      );
    };

    it("should return list of api keys for user", async () => {
      const apiKeys = await createApiKeys(uid, 2);
      await apiKeyService.create({ uid: "should-not-be-returned" });

      const actual = await apiKeyService.list({ uid });

      expectApiKeys(actual, apiKeys);
    });

    it("should throw invalid argument is no uid is given", async () => {
      await createApiKeys(uid, 2);

      await expect(apiKeyService.list({})).rejects.toThrow(InvalidArgumentError);
    });

    it("should return list of api keys limited to pageSize", async () => {
      const apiKeys = await createApiKeys(uid, 20);
      const pageSize = 7;

      const actual = await apiKeyService.list({ uid, pageSize });

      expectApiKeys(actual, apiKeys.slice(0, pageSize));
      expect(actual).toHaveProperty("nextPageToken");
    });

    it("should default pageSize to 100", async () => {
      const apiKeys = await createApiKeys(uid, 102);

      const actual = await apiKeyService.list({ uid });

      expectApiKeys(actual, apiKeys.slice(0, 100));
      expect(actual).toHaveProperty("nextPageToken");
    });

    it("should return nextPageToken that gets the next page", async () => {
      const apiKeys = await createApiKeys(uid, 15);
      const pageSize = 5;
      const { nextPageToken: pageToken } = await apiKeyService.list({ uid, pageSize });

      const actual = await apiKeyService.list({ uid, pageSize, pageToken });

      expectApiKeys(actual, apiKeys.slice(5, 5 + pageSize));
      expect(actual).toHaveProperty("nextPageToken");
    });

    it("should throw InvalidArgument if uid is different in the pageToken", async () => {
      await createApiKeys(uid, 15);
      const pageSize = 5;
      const { nextPageToken: pageToken } = await apiKeyService.list({ uid, pageSize });

      await expect(apiKeyService.list({ uid: "different-uid", pageSize, pageToken }))
        .rejects.toThrow(InvalidArgumentError);
    });

    it("should throw InvalidArgument if pageSize is different in the pageToken", async () => {
      await createApiKeys(uid, 15);
      const pageSize = 5;
      const { nextPageToken: pageToken } = await apiKeyService.list({ uid, pageSize });

      await expect(apiKeyService.list({ uid, pageSize: 10, pageToken }))
        .rejects.toThrow(InvalidArgumentError);
    });

    const updatePageToken = (rawPageToken, applyFn) => {
      const decodedPageToken = Buffer.from(rawPageToken, "base64url").toString();
      const pageToken = JSON.parse(decodedPageToken);
      const newPageToken = applyFn(pageToken);
      const encodedNewPageToken = JSON.stringify(newPageToken);
      const rawNewPageToken = Buffer.from(encodedNewPageToken).toString("base64url");
      return rawNewPageToken;
    };

    it("should throw InvalidArgument if lastCreatedAtMillis is not a number", async () => {
      await createApiKeys(uid, 15);
      const pageSize = 5;
      let { nextPageToken: pageToken } = await apiKeyService.list({ uid, pageSize });
      pageToken = updatePageToken(pageToken, pageToken => ({ ...pageToken, lastCreatedAtMillis: "foo" }));

      await expect(apiKeyService.list({ uid, pageSize, pageToken }))
        .rejects.toThrow(InvalidArgumentError);
    });

    it("should throw InvalidArgument if lastCreatedAtMillis is less than zero", async () => {
      await createApiKeys(uid, 15);
      const pageSize = 5;
      let { nextPageToken: pageToken } = await apiKeyService.list({ uid, pageSize });
      pageToken = updatePageToken(pageToken, pageToken => ({ ...pageToken, lastCreatedAtMillis: -1 }));

      await expect(apiKeyService.list({ uid, pageSize, pageToken }))
        .rejects.toThrow(InvalidArgumentError);
    });

    it("should return page token that can be used to retrieve all results", async () => {
      await createApiKeys(uid, 14);
      const pageSize = 5;

      let count = 0;
      let pageToken;
      do {
        const { nextPageToken } = await apiKeyService.list({ uid, pageSize, pageToken });
        count++;
        pageToken = nextPageToken;
      } while (pageToken);

      // Count should be
      expect(count).toBe(3);
    });
  });
});
