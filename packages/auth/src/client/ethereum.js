import { getDataOrThrowError } from "./utils.js";

const buidlGetNonce = ({ getJSON }) => async ({ address }) => {
  const res = await getJSON(`/authenticate/ethereum/${address}`);
  const nonce = await getDataOrThrowError(res);
  return nonce;
};

const buildAuthenticate = ({ postJSON }) => async ({ address, nonce, signature }) => {
  const res = await postJSON(`/authenticate/ethereum/${address}`, { nonce, signature });
  const { refresh_token, access_token } = await getDataOrThrowError(res);
  return { refresh_token, access_token };
};

export const buildEthereumClient = ({ getJSON, postJSON }) => {
  return {
    authenticate: buildAuthenticate({ postJSON }),
    getNonce: buidlGetNonce({ getJSON }),
  };
};
