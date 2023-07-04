import { admin } from "./firebase.js";

const buildCompileCreate = ({ db }) => async ({ id, compile, auth }) => {
  const compileRef = db.doc(`compiles/${id}`);
  const compileDoc = await compileRef.get();

  if (!compileDoc.exists) {
    await compileRef.set(compile);
  }
  return id;
};

const buildCompileGet = ({ db }) => async ({ id, auth }) => {
  const compileRef = db.doc(`compiles/${id}`);
  const compileDoc = await compileRef.get();

  if (!compileDoc.exists) {
    return undefined;
  }
  return compileDoc.data();
};

export const buildCompileStorer = () => {
  const db = admin.firestore();
  const create = buildCompileCreate({ db });
  const get = buildCompileGet({ db });
  return { create, get };
};
