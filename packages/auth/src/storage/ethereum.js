import { getFirestore } from "../firebase.js";
import { generateNonce } from "../utils.js";

const buildRotateNonce = ({ db }) => async ({ address }) => {
  address = address.toLowerCase();
  const ref = db.doc(`nonces/${address}`);
  const nonce = await generateNonce();
  await ref.set({ nonce });
  return nonce;
};

const buildGetNonce = ({ db, rotateNonce }) => async ({ address }) => {
  address = address.toLowerCase();
  const ref = db.doc(`nonces/${address}`);
  const doc = await ref.get();
  let nonce;
  if (doc.exists) {
    nonce = doc.get("nonce");
  } else {
    nonce = await rotateNonce({ address });
  }
  return nonce;
};

export const buildEthereumStorer = () => {
  const db = getFirestore();
  const rotateNonce = buildRotateNonce({ db });
  const getNonce = buildGetNonce({ db, rotateNonce });

  return { rotateNonce, getNonce };
};
