import { decodeID, encodeID } from "../id.js";
import { NotFoundError } from "../errors/http.js";

// const dumpMap = (map) => console.log(JSON.stringify(Array.from(map.entries()), null, 2));

const appendIds = (id, ...otherIds) => [id, ...otherIds].join("+");

const buildCheckAuth = ({ aclsById }) => ({ id, auth }) => {
  if (!aclsById.has(id)) {
    return;
  }
  const acls = aclsById.get(id);
  if (acls.public) {
    return;
  }
  if (!auth) {
    throw new NotFoundError();
  }
  if (acls.uids.has(auth.uid)) {
    return;
  }
  throw new NotFoundError();
};

const buildObjectToId = ({ idsByObject, objectsById }) => obj => {
  if (obj === null) {
    return 0;
  }
  const key = JSON.stringify(obj);
  if (!idsByObject.has(key)) {
    const newId = objectsById.size + 1;
    idsByObject.set(key, newId);
    objectsById.set(newId, obj);
  }
  // console.log("### objectToId() objectsById");
  // dumpMap(objectsById);
  return idsByObject.get(key);
};

const buildObjectFromId = ({ objectsById }) => id => objectsById.get(id);

const buildSetObjectToId = ({ idsByObject, objectsById }) => (id, obj) => {
  if (obj === null) {
    return 0;
  }
  if (!objectsById.has(id)) {
    objectsById.set(id, obj);
  }
  // console.log("### setObjectById() objectsById");
  // dumpMap(objectsById);
  return id;
};

// Tasks

const buildTaskCreate = ({ objectToId, aclsById }) => async ({ task, auth }) => {
  const langId = task.lang;
  const codeId = objectToId(task.code);
  const id = encodeID([langId, codeId, 0]);
  if (!aclsById.has(id)) {
    aclsById.set(id, { public: false, uids: new Set() });
  }
  const acls = aclsById.get(id);
  if (auth) {
    acls.uids.add(auth.uid);
  } else {
    acls.public = true;
  }
  return id;
};

const buildTaskGet = ({ objectFromId, aclsById }) => {
  const checkAuth = buildCheckAuth({ aclsById });
  return async ({ id, auth }) => {
    const tasks = [];
    let ids = decodeID(id);
    while (ids.length > 2) {
      const [langId, codeId, ...dataIds] = ids;

      const lang = langId.toString();
      const code = objectFromId(codeId);
      if (!code) {
        throw new NotFoundError();
      }

      const subTaskId = encodeID([langId, codeId, 0]);
      checkAuth({ id: subTaskId, auth });
      tasks.push({ lang, code });

      ids = dataIds;
    }

    return tasks;
  };
};

export const buildMemoryTaskDao = () => {
  const aclsById = new Map();
  const idsByObject = new Map([[JSON.stringify({}), 1]]);
  const objectsById = new Map([[1, {}]]);

  const objectToId = buildObjectToId({ idsByObject, objectsById });
  const objectFromId = buildObjectFromId({ objectsById });

  const create = buildTaskCreate({ objectToId, aclsById });
  const get = buildTaskGet({ objectFromId, aclsById });

  return { create, get, appendIds };
};

// Compiles

const buildCompileCreate = ({ setObjectToId, aclsById }) => async ({ id, compile }) => {
  setObjectToId(id, compile);
  return id;
};

const buildCompileGet = ({ objectFromId, aclsById }) => {
  return async ({ id, auth }) => {
    return objectFromId(id);
  };
};

export const buildMemoryCompileDao = () => {
  const aclsById = new Map();
  const idsByObject = new Map([[JSON.stringify({}), 1]]);
  const objectsById = new Map([[1, {}]]);

  const setObjectToId = buildSetObjectToId({ idsByObject, objectsById });
  const objectFromId = buildObjectFromId({ objectsById });
  const create = buildCompileCreate({ setObjectToId, aclsById });

  const get = buildCompileGet({ objectFromId, aclsById });
  return { create, get, appendIds };
};
