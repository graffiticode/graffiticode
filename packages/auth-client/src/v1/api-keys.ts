import { InvalidArgumentError } from "@graffiticode/common/errors";
import { isNonEmptyString } from "@graffiticode/common/utils";
import { getDataOrThrowError } from "../utils.js";
import type { Context, JSONRequest } from "../utils.js";

export const buildCreateApiKey = (context: Context, { postJSON }: { postJSON: JSONRequest }) => async ({ accessToken }: { accessToken?: string } = {}) => {
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

export const buildDeleteApiKey = (context: Context, { deleteJSON }: { deleteJSON: JSONRequest }) => async ({ accessToken, apiKeyId }: { accessToken?: string; apiKeyId?: string } = {}) => {
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

export const buildSignInWithApiKey = (context: Context, { postJSON }: { postJSON: JSONRequest }) => async ({ apiKeyId, apiKeySecret }: { apiKeyId: string; apiKeySecret: string }) => {
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
