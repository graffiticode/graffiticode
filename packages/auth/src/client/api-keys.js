import { isNonEmptyString } from "@graffiticode/common/utils";
import { getDataOrThrowError } from "./utils.js";

const buildAuthenticate = ({ postJSON }) => async ({ token }) => {
  const res = await postJSON("/authenticate/api-key", { token });
  const data = await getDataOrThrowError(res);
  return data;
};

const buildCreate = ({ postJSON }) => async (token) => {
  if (!isNonEmptyString(token)) {
    throw new Error("must provide a token");
  }
  const res = await postJSON("/api-keys", {}, { Authorization: token });
  const data = await getDataOrThrowError(res);
  return data;
};

const buildRemove = ({ deleteJSON }) => async ({ token, id }) => {
  if (!isNonEmptyString(token)) {
    throw new Error("must provide a token");
  }
  if (!isNonEmptyString(id)) {
    throw new Error("must provide an id");
  }
  const res = await deleteJSON(`/api-keys/${id}`, {}, { Authorization: token });
  await getDataOrThrowError(res);
};

export const buildApiKeysClient = ({ postJSON, deleteJSON }) => {
  return {
    authenticate: buildAuthenticate({ postJSON }),
    create: buildCreate({ postJSON }),
    remove: buildRemove({ deleteJSON }),
  };
};
