import { buildFirestoreKeyStorer } from "./firestore.js";
import { buildMemoryKeyStorer } from "./memory.js";

export const createKeyStorer = type => {
  if (type === "firestore") {
    return buildFirestoreKeyStorer();
  }
  if (type === "memory") {
    return buildMemoryKeyStorer();
  }
  throw new Error(`unknown key storer type: ${type}`);
};
