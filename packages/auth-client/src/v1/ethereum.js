import { isNonEmptyString } from "@graffiticode/common/utils";
import { getDataOrThrowError } from "../utils.js";
import { ecsign, hashPersonalMessage, toRpcSig } from "@ethereumjs/util";

export const buildGetEthereumNonce = (context, { getJSON }) => async ({ address }) => {
  if (!isNonEmptyString(address)) {
    throw new Error("must provide an address");
  }
  const res = await getJSON(`/ethereum/${address}`);
  const { nonce } = await getDataOrThrowError(res);
  return nonce;
};

export const buildSignInWithEthereum = (context, { postJSON }) => async ({ address, nonce, signature }) => {
  if (!isNonEmptyString(address)) {
    throw new Error("must provide an address");
  }
  if (!isNonEmptyString(nonce)) {
    throw new Error("must provide a nonce");
  }
  if (!isNonEmptyString(signature)) {
    throw new Error("must provide a signature");
  }

  const res = await postJSON(`/ethereum/${address}/authenticate`, { nonce, signature });
  const { refreshToken, accessToken } = await getDataOrThrowError(res);

  // TODO version the auth tokens to prevent overriding newer tokens
  context.set("refreshToken", refreshToken);
  context.set("accessToken", accessToken);

  return { refreshToken, accessToken };
};

const createMessageHash = ({ nonce }) => {
  const msg = `Nonce: ${nonce}`;
  const msgBuffer = Buffer.from(msg, "ascii");
  return hashPersonalMessage(msgBuffer);
};

export const createSignature = ({ privateKey, nonce }) => {
  const msgHash = createMessageHash({ nonce });
  const sig = ecsign(msgHash, privateKey);
  return toRpcSig(sig.v, sig.r, sig.s);
};
