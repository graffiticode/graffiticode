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
  const now = new Date().toISOString();

  if (!compileDoc.exists) {
    // New document - set count to 1, firstCompile and lastCompile timestamps
    await compileRef.set({
      ...encodeCompileData(compile),
      count: 1,
      firstCompile: now,
      lastCompile: now,
    });
  } else {
    // Existing document - increment count (default to 1 if no count field) and update lastCompile
    const currentData = compileDoc.data();
    const currentCount = currentData.count || 1;
    await compileRef.update({
      count: currentCount + 1,
      lastCompile: now,
    });
  }
  return id;
};

const buildCompileGet = ({ db }) => async ({ id, auth }) => {
  const compileRef = db.doc(`compiles/${id}`);
  const compileDoc = await compileRef.get();
  if (!compileDoc.exists) {
    return undefined;
  }
  // Increment count (default to 1 if no count field) and update lastCompile
  const currentData = compileDoc.data();
  const currentCount = currentData.count || 1;
  const now = new Date().toISOString();
  await compileRef.update({
    count: currentCount + 1,
    lastCompile: now,
  });
  // Get the updated document
  const updatedDoc = await compileRef.get();
  return decodeCompileData(updatedDoc.data());
};

export const buildCompileStorer = () => {
  const db = admin.firestore();
  const create = buildCompileCreate({ db });
  const get = buildCompileGet({ db });
  return { create, get };
};
