import { NotFoundError, UnauthenticatedError } from "@graffiticode/common/errors";

const buildCreate = ({ apiKeyStorer }) => async ({ uid }) => {
  const apiKey = await apiKeyStorer.createApiKey({ uid });
  return apiKey;
};

const buildAuthenticate = ({ apiKeyStorer }) => async ({ apiKey }) => {
  try {
    const { uid } = await apiKeyStorer.getApiKey(apiKey);
    return { uid };
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new UnauthenticatedError("invalid api-key");
    }
    throw err;
  }
};

export const buildApiKeyService = (deps) => {
  return {
    create: buildCreate(deps),
    authenticate: buildAuthenticate(deps),
  };
};
