import { InvalidArgumentError } from "@graffiticode/common/errors";
import { isNonEmptyString } from "@graffiticode/common/utils";
import { getDataOrThrowError } from "../utils.js";

export const buildCreateApiKey = (context, { postJSON }) => async ({ accessToken } = {}) => {
  if (!isNonEmptyString(accessToken) && context.has("accessToken")) {
    accessToken = context.get("accessToken");
  }
  if (!isNonEmptyString(accessToken)) {
    throw new InvalidArgumentError("must provide an accessToken");
  }

  const headers = { Authorization: accessToken };
  const res = await postJSON("/api-keys", null, headers);
  const data = await getDataOrThrowError(res);

  return data;
};

export const buildDeleteApiKey = (context, { deleteJSON }) => async ({ accessToken, apiKeyId } = {}) => {
  if (!isNonEmptyString(accessToken) && context.has("accessToken")) {
    accessToken = context.get("accessToken");
  }
  if (!isNonEmptyString(accessToken)) {
    throw new InvalidArgumentError("must provide an accessToken");
  }
  if (!isNonEmptyString(apiKeyId)) {
    throw new InvalidArgumentError("must provide an apiKeyId");
  }

  const headers = { Authorization: accessToken };
  const res = await deleteJSON(`/api-keys/${apiKeyId}`, null, headers);
  await getDataOrThrowError(res);
};

export const buildSignInWithApiKey = (context, { postJSON }) => async ({ apiKeyId, apiKeySecret }) => {
  if (!isNonEmptyString(apiKeyId)) {
    throw new InvalidArgumentError("must provide an apiKeyId");
  }
  if (!isNonEmptyString(apiKeySecret)) {
    throw new InvalidArgumentError("must provide an apiKeySecret");
  }

  const body = { token: apiKeySecret };
  const res = await postJSON(`/api-keys/${apiKeyId}/authenticate`, body);
  const data = await getDataOrThrowError(res);
  const { accessToken } = data;

  // TODO version the auth tokens to prevent overriding newer tokens
  context.set("accessToken", accessToken);

  return data;
};
