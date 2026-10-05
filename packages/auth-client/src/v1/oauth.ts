import { InvalidArgumentError } from "@graffiticode/common/errors";
import { isNonEmptyString } from "@graffiticode/common/utils";
import { getDataOrThrowError } from "../utils.js";

export const buildSignInWithGoogle = (context, { postJSON }) => async ({ idToken }) => {
  if (!isNonEmptyString(idToken)) {
    throw new InvalidArgumentError("must provide idToken");
  }

  const res = await postJSON("/authenticate/google", { idToken });
  const data = await getDataOrThrowError(res);
  const { refresh_token: refreshToken, access_token: accessToken, firebaseCustomToken } = data;

  // Store tokens in context (same as signInWithEthereum)
  context.set("refreshToken", refreshToken);
  context.set("accessToken", accessToken);

  return { refreshToken, accessToken, firebaseCustomToken };
};

export const buildCreateOAuthLink = (context, { postJSON }) => async ({ token, provider, idToken }) => {
  if (!isNonEmptyString(token)) {
    throw new InvalidArgumentError("must provide token");
  }
  if (!isNonEmptyString(provider)) {
    throw new InvalidArgumentError("must provide provider");
  }
  if (!isNonEmptyString(idToken)) {
    throw new InvalidArgumentError("must provide idToken");
  }

  const res = await postJSON("/oauth-links", { provider, idToken }, { Authorization: token });
  const data = await getDataOrThrowError(res);
  return data;
};

export const buildGetOAuthLinks = (context, { getJSON }) => async ({ token }) => {
  if (!isNonEmptyString(token)) {
    throw new InvalidArgumentError("must provide token");
  }

  const res = await getJSON("/oauth-links", { Authorization: token });
  const data = await getDataOrThrowError(res);
  return data.links;
};

export const buildDeleteOAuthLink = (context, { deleteJSON }) => async ({ token, provider }) => {
  if (!isNonEmptyString(token)) {
    throw new InvalidArgumentError("must provide token");
  }
  if (!isNonEmptyString(provider)) {
    throw new InvalidArgumentError("must provide provider");
  }

  const res = await deleteJSON(`/oauth-links/${provider}`, { Authorization: token });
  const data = await getDataOrThrowError(res);
  return data;
};
