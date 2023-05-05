import { ecrecover, ecsign, fromRpcSig, hashPersonalMessage, isValidSignature, publicToAddress, toRpcSig } from "@ethereumjs/util";
import { InvalidArgumentError, UnauthenticatedError } from "@graffiticode/common/src/errors.js";
import { NonceMismatchError } from "../errors/ethereum.js";

const buildGetNonce = ({ ethereumStorer }) => async ({ address }) => ethereumStorer.getNonce({ address });

const parseRpcSignature = ({ signature }) => {
  try {
    const sig = fromRpcSig(signature);
    if (!isValidSignature(sig.v, sig.r, sig.s)) {
      throw new InvalidArgumentError(`invalid signature: ${signature}`);
    }
    return sig;
  } catch (err) {
    if (err.message.includes("Invalid signature length")) {
      throw new InvalidArgumentError("invalid signature length");
    }
    throw err;
  }
};

const createMessageHash = ({ nonce }) => {
  const msg = `Nonce: ${nonce}`;
  const msgBuffer = Buffer.from(msg, "ascii");
  return hashPersonalMessage(msgBuffer);
};

const extractSignatureAddress = ({ nonce, signature }) => {
  const sig = parseRpcSignature({ signature });
  const msgHash = createMessageHash({ nonce });
  const publicKey = ecrecover(msgHash, sig.v, sig.r, sig.s);
  return publicToAddress(publicKey).toString("hex").toLowerCase();
};

const buildAuthenticate = ({ ethereumStorer }) => async ({ address, nonce, signature }) => {
  address = address.toLowerCase();

  // Verify the current nonce matches the nonce param
  const currentNonce = await ethereumStorer.getNonce({ address });
  if (nonce !== currentNonce) {
    throw new NonceMismatchError();
  }

  // Verify the signature address matches the address param
  const signatureAddress = extractSignatureAddress({ nonce, signature });
  if (signatureAddress.toLowerCase() !== address.toLowerCase()) {
    throw new UnauthenticatedError("address mismatch");
  }

  // Rotate the address nonce to prevent replay attacks
  await ethereumStorer.rotateNonce({ address });

  return { uid: address };
};

export const buildEthereumService = ({ ethereumStorer }) => {
  const getNonce = buildGetNonce({ ethereumStorer });
  const authenticate = buildAuthenticate({ ethereumStorer });
  return { getNonce, authenticate };
};

export const createSignature = ({ privateKey, nonce }) => {
  const msgHash = createMessageHash({ nonce });
  const sig = ecsign(msgHash, privateKey);
  return toRpcSig(sig.v, sig.r, sig.s);
};
