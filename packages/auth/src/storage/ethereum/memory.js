import { generateNonce } from "../../utils.js";

const buildRotateNonce = ({ nonces }) => async ({ address }) => {
  address = address.toLowerCase();
  nonces.set(address, generateNonce());
};

const buildGetNonce = ({ nonces, rotateNonce }) => async ({ address }) => {
  address = address.toLowerCase();
  if (!nonces.has(address)) {
    rotateNonce({ address });
  }
  const nonce = await nonces.get(address);
  return nonce;
};

export const buildMemoryEthereumStorer = () => {
  const nonces = new Map();
  const rotateNonce = buildRotateNonce({ nonces });
  const getNonce = buildGetNonce({ nonces, rotateNonce });
  return { rotateNonce, getNonce };
};
