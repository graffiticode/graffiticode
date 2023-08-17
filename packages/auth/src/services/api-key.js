import { NotFoundError, UnauthenticatedError, UnauthorizedError } from "@graffiticode/common/errors";

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

export const buildApiKeyService = (deps) => {
  return {
    authenticate: buildAuthenticate(deps),
    create: buildCreate(deps),
    remove: buildRemove(deps),
  };
};
