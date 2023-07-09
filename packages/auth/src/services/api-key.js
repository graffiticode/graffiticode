import { NotFoundError, UnauthenticatedError, UnauthorizedError } from "@graffiticode/common/errors";

const buildCreate = ({ apiKeyStorer }) => async ({ uid }) => {
  const apiKey = await apiKeyStorer.createApiKey({ uid });
  return apiKey;
};

const buildRemove = ({ apiKeyStorer }) => async ({ requestingUid, apiKey }) => {
  const { uid } = await apiKeyStorer.getApiKey(apiKey);
  if (uid !== requestingUid) {
    throw new UnauthorizedError();
  }
  await apiKeyStorer.deleteApiKey(apiKey);
};

const buildAuthenticate = ({ apiKeyStorer }) => async ({ apiKey }) => {
  try {
    const { uid } = await apiKeyStorer.getApiKey(apiKey);
    const additionalClaims = { apiKey: true };
    return { uid, additionalClaims };
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new UnauthenticatedError("invalid api-key");
    }
    throw err;
  }
};

export const buildApiKeyService = (deps) => {
  return {
    authenticate: buildAuthenticate(deps),
    create: buildCreate(deps),
    remove: buildRemove(deps),
  };
};
