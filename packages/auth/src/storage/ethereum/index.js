import { buildFirestoreEthereumStorer } from "./firestore.js";
import { buildMemoryEthereumStorer } from "./memory.js";

export const createEthereumStorer = type => {
  if (type === "firestore") {
    return buildFirestoreEthereumStorer();
  }
  if (type === "memory") {
    return buildMemoryEthereumStorer();
  }
  throw new Error(`unknown ethereum storer type: ${type}`);
};
