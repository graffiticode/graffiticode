import { buildFirestoreTokenStorer } from "./firestore.js";
import { buildMemoryTokenStorer } from "./memory.js";

export const createTokenStorer = type => {
  if (type === "firestore") {
    return buildFirestoreTokenStorer();
  }
  if (type === "memory") {
    return buildMemoryTokenStorer();
  }
  throw new Error(`unknown token storer type: ${type}`);
};
