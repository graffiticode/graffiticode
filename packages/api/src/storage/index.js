import { buildMemoryTaskDao, buildMemoryCompileDao } from "./memory.js";
import { buildFirestoreTaskDao, buildFirestoreCompileDao } from "./firestore.js";

const buildCreateTask = ({ cache }) => ({ type = "persistent" } = {}) => {
  if (!cache.has(type)) {
    let taskDao;
    if (type === "memory") {
      taskDao = buildMemoryTaskDao();
    } else if (type === "ephemeral" || type === "persistent" || type === "firestore") {
      taskDao = buildFirestoreTaskDao();
    } else {
      throw new Error(`no TaskDao with type ${type}`);
    }
    cache.set(type, taskDao);
  }
  return cache.get(type);
};

const buildCreateCompile = ({ cache }) => ({ type = "persistent" } = {}) => {
  if (!cache.has(type)) {
    let compileDao;
    if (type === "memory") {
      compileDao = buildMemoryCompileDao();
    } else if (
      type === "persistent" ||
      type === "ephemeral" ||
      type === "firestore") {
      compileDao = buildFirestoreCompileDao();
    } else {
      throw new Error(`no TaskDao with type ${type}`);
    }
    cache.set(type, compileDao);
  }
  return cache.get(type);
};

export const buildTaskDaoFactory = () => {
  const cache = new Map();
  const create = buildCreateTask({ cache });
  return { create };
};

export const buildCompileDaoFactory = () => {
  const cache = new Map();
  const create = buildCreateCompile({ cache });
  return { create };
};
