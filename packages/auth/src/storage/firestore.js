import { buildFirestoreEthereumStorer } from "./ethereum/firestore.js";
import { buildFirestoreKeyStorer } from "./keys/firestore.js";
import { buildFirestoreTokenStorer } from "./tokens/firestore.js";

export const buildFirestoreStorers = () => {
  const ethereumStorer = buildFirestoreEthereumStorer();
  const keyStorer = buildFirestoreKeyStorer();
  const tokenStorer = buildFirestoreTokenStorer();
  return { ethereumStorer, keyStorer, tokenStorer };
};
