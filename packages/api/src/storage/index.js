import { buildMemoryTaskDao } from "./memory.js";
import { buildFirestoreTaskDao, createFirestoreDb } from "./firestore.js";

const buildCreate = ({ cache }) => ({ type = "persistent" } = {}) => {
  if (!cache.has(type)) {
    let taskDao;
    if (type === "ephemeral" || type === "memory") {
      taskDao = buildMemoryTaskDao();
    } else if (type === "persistent" || type === "firestore") {
      const db = createFirestoreDb({});
      taskDao = buildFirestoreTaskDao({ db });
    } else {
      throw new Error(`no TaskDao with type ${type}`);
    }
    cache.set(type, taskDao);
  }
  return cache.get(type);
};

export const buildTaskDaoFactory = () => {
  const cache = new Map();
  const create = buildCreate({ cache });
  return { create };
};
