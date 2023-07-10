import { getDataOrThrowError } from "./utils.js";

const buidlGetNonce = ({ getJSON }) => async ({ address }) => {
  const res = await getJSON(`/authenticate/ethereum/${address}`);
  const nonce = await getDataOrThrowError(res);
  return nonce;
};

const buildAuthenticate = ({ postJSON }) => async ({ address, nonce, signature }) => {
  const res = await postJSON(`/authenticate/ethereum/${address}`, { nonce, signature });
  const data = await getDataOrThrowError(res);
  return data;
};

export const buildEthereumClient = ({ getJSON, postJSON }) => {
  return {
    authenticate: buildAuthenticate({ postJSON }),
    getNonce: buidlGetNonce({ getJSON }),
  };
};
