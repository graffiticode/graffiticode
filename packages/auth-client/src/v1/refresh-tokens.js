import { InvalidArgumentError } from "@graffiticode/common/errors";
import { isNonEmptyString } from "@graffiticode/common/utils";
import { getDataOrThrowError } from "../utils.js";

export const buildExchangeRefreshToken = (context, { postJSON }) => async ({ refreshToken } = {}) => {
  if (!isNonEmptyString(refreshToken) && context.has("refreshToken")) {
    refreshToken = context.get("refreshToken");
  }
  if (!isNonEmptyString(refreshToken)) {
    throw new InvalidArgumentError("must provide a refreshToken");
  }

  const res = await postJSON("/refresh-tokens/exchange", { refreshToken });
  const data = await getDataOrThrowError(res);
  const { accessToken } = data;

  // TODO version the auth tokens to prevent overriding newer tokens
  context.set("accessToken", accessToken);

  return { accessToken };
};

export const buildRevokeRefreshToken = (context, { postJSON }) => async ({ refreshToken } = {}) => {
  if (!isNonEmptyString(refreshToken) && context.has("refreshToken")) {
    refreshToken = context.get("refreshToken");
  }
  if (!isNonEmptyString(refreshToken)) {
    throw new InvalidArgumentError("must provide a refreshToken");
  }

  const res = await postJSON("/refresh-tokens/revoke", { refreshToken });
  await getDataOrThrowError(res);
};
