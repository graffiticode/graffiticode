import { admin } from "./firebase.js";

function encodeCompileData(compile) {
  // We do this because not all objects are be stored natively in firestore.
  // E.g. arrays of arrays are not compatible.
  return {
    ...compile,
    data: JSON.stringify(compile.data),
  };
}

function decodeCompileData(compile) {
  try {
    return {
      ...compile,
      data: JSON.parse(compile.data),
    };
  } catch (x) {
    console.log("decodeCompileData() legacy compile=" + JSON.stringify(compile, null, 2));
    return compile;
  }
}

const buildCompileCreate = ({ db }) => async ({ id, compile, auth }) => {
  const compileRef = db.doc(`compiles/${id}`);
  const compileDoc = await compileRef.get();
  console.log("compileCreate() id=" + id);
  console.log("compileCreate() compile=" + JSON.stringify(compile, null, 2));
  if (!compileDoc.exists) {
    await compileRef.set(encodeCompileData(compile));
  }
  return id;
};

const buildCompileGet = ({ db }) => async ({ id, auth }) => {
  const compileRef = db.doc(`compiles/${id}`);
  const compileDoc = await compileRef.get();

  if (!compileDoc.exists) {
    return undefined;
  }
  return decodeCompileData(compileDoc.data());
};

export const buildCompileStorer = () => {
  const db = admin.firestore();
  const create = buildCompileCreate({ db });
  const get = buildCompileGet({ db });
  return { create, get };
};
