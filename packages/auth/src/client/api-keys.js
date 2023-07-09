import { getDataOrThrowError } from "./utils.js";

const buildAuthenticate = ({ postJSON }) => async ({ apiKey }) => {
  const res = await postJSON("/authenticate/api-key", { apiKey });
  const { refresh_token, access_token } = await getDataOrThrowError(res);
  return { refresh_token, access_token };
};
const buildCreate = ({ postJSON }) => async ({ token }) => {
  const res = await postJSON("/api-keys", {}, { Authorization: token });
  const { apiKey } = await getDataOrThrowError(res);
  return { apiKey };
};

export const buildApiKeyClient = ({ postJSON }) => {
  return {
    authenticate: buildAuthenticate({ postJSON }),
    create: buildCreate({ postJSON }),
  };
};
