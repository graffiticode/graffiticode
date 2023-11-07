import { Buffer } from "node:buffer";
import {
  InvalidArgumentError,
  NotFoundError,
  UnauthenticatedError,
  UnauthorizedError,
} from "@graffiticode/common/errors";
import { isNonEmptyString } from "@graffiticode/common/utils";

const buildCreate = ({ apiKeyStorer }) => async ({ uid }) => {
  const apiKey = await apiKeyStorer.create({ uid });
  return apiKey;
};

const buildRemove = ({ apiKeyStorer }) => async ({ requestingUid, id }) => {
  const { uid } = await apiKeyStorer.findById(id);
  if (uid !== requestingUid) {
    throw new UnauthorizedError();
  }
  await apiKeyStorer.removeById(id);
};

const populateAndValidateListRequestParams = ({ uid, pageSize, pageToken }) => {
  if (!isNonEmptyString(uid)) {
    throw new InvalidArgumentError("must provide uid");
  }
  if (!Number.isInteger(pageSize)) {
    pageSize = 100;
  }
  if (!isNonEmptyString(pageToken)) {
    pageToken = null;
  }
  return { uid, pageSize, pageToken };
};

const parseAndValidatePageToken = (rawPageToken, params) => {
  if (!isNonEmptyString(rawPageToken)) {
    return { uid: params.uid, pageSize: params.pageSize, lastCreatedAtMillis: 0 };
  }
  const decodedPageToken = Buffer.from(rawPageToken, "base64url").toString();
  const pageToken = JSON.parse(decodedPageToken);
  if (params.uid !== pageToken.uid) {
    throw new InvalidArgumentError("invalid uid from pageToken");
  }
  if (params.pageSize !== pageToken.pageSize) {
    throw new InvalidArgumentError("invalid pageSize from pageToken");
  }
  if (!Number.isInteger(pageToken.lastCreatedAtMillis) || pageToken.lastCreatedAtMillis < 0) {
    throw new InvalidArgumentError("invalid lastCreatedAtMillis from pageToken");
  }
  return pageToken;
};

const createNextPageToken = ({ apiKeys, uid, pageSize }) => {
  if (apiKeys.length < pageSize) {
    return null;
  }
  const lastCreatedAtMillis = apiKeys[apiKeys.length - 1].createdAt.toMillis();
  const nextPageToken = { uid, pageSize, lastCreatedAtMillis };
  const encodedNextPageToken = JSON.stringify(nextPageToken);
  const rawNextPageToken = Buffer.from(encodedNextPageToken).toString("base64url");
  return rawNextPageToken;
};

const buildList = ({ apiKeyStorer }) => async (params) => {
  const { uid, pageSize, pageToken } = populateAndValidateListRequestParams(params);
  const { lastCreatedAtMillis } = parseAndValidatePageToken(pageToken, { uid, pageSize });

  const apiKeys = await apiKeyStorer.list({
    uid,
    limit: pageSize,
    createdAfterMillis: lastCreatedAtMillis,
  });
  const nextPageToken = createNextPageToken({ apiKeys, uid, pageSize });

  return { apiKeys, nextPageToken };
};

const buildAuthenticate = ({ apiKeyStorer }) => async ({ token }) => {
  try {
    const { uid } = await apiKeyStorer.findByToken(token);
    const additionalClaims = { apiKey: true };
    return { uid, additionalClaims };
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new UnauthenticatedError("invalid api-key");
    }
    throw err;
  }
};

const buildAuthenticateWithId = ({ apiKeyStorer }) => async ({ id, token }) => {
  try {
    const { id: tokenId, uid } = await apiKeyStorer.findByToken(token);
    if (tokenId !== id) {
      throw new UnauthenticatedError();
    }
    const additionalClaims = { apiKey: true, apiKeyId: tokenId };
    return { uid, additionalClaims };
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new UnauthenticatedError();
    }
    throw err;
  }
};

export const buildApiKeyService = (deps) => {
  return {
    create: buildCreate(deps),
    remove: buildRemove(deps),

    list: buildList(deps),

    authenticate: buildAuthenticate(deps),
    authenticateWithId: buildAuthenticateWithId(deps),
  };
};
