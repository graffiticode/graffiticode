import { isNonEmptyString } from "@graffiticode/common/utils";
import { getDataOrThrowError } from "./utils.js";

const buildAuthenticate = ({ postJSON }) => async ({ apiKey }) => {
  const res = await postJSON("/authenticate/api-key", { apiKey });
  const { access_token } = await getDataOrThrowError(res);
  return { access_token };
};

const buildCreate = ({ postJSON }) => async (token) => {
  if (!isNonEmptyString(token)) {
    throw new Error("must provide a token");
  }
  const res = await postJSON("/api-keys", {}, { Authorization: token });
  const { apiKey } = await getDataOrThrowError(res);
  return { apiKey };
};

const buildRemove = ({ deleteJSON }) => async ({ token, apiKey }) => {
  if (!isNonEmptyString(token)) {
    throw new Error("must provide a token");
  }
  if (!isNonEmptyString(apiKey)) {
    throw new Error("must provide a apiKey");
  }
  const res = await deleteJSON(`/api-keys/${apiKey}`, {}, { Authorization: token });
  await getDataOrThrowError(res);
};

export const buildApiKeysClient = ({ postJSON, deleteJSON }) => {
  return {
    authenticate: buildAuthenticate({ postJSON }),
    create: buildCreate({ postJSON }),
    remove: buildRemove({ deleteJSON }),
  };
};
