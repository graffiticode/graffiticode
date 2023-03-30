import { buildFirestoreStorers } from "./firestore.js";
import { buildMemoryStorers } from "./memory.js";

export const createStorers = type => {
  if (type === "firestore") {
    return buildFirestoreStorers();
  }
  if (type === "memory") {
    return buildMemoryStorers();
  }
  throw new Error(`unknown storage type: ${type}`);
};
