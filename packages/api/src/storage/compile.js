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

// Every compile of an id counts once and moves lastCompile; a doc written
// before firstCompile existed gets it from its legacy `timestamp`.
const recompiled = (current, now) => ({
  count: (current.count || 1) + 1,
  lastCompile: now,
  ...(!current.firstCompile && current.timestamp
    ? { firstCompile: new Date(current.timestamp).toISOString() }
    : {})
});

const buildCompileCreate = ({ db }) => async ({ id, compile, auth, overwrite = false }) => {
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
  } else if (overwrite) {
    // A forced recompile (see data.js `refresh`). Without this the stored data
    // was write-once — an existing doc only ever had count/lastCompile moved —
    // so a verdict recorded before a breaking compiler change could never be
    // corrected, only deleted. Keep count and firstCompile: this is the same
    // task compiled again, not a new one.
    await compileRef.update({
      ...encodeCompileData(compile),
      ...recompiled(compileDoc.data(), now)
    });
  } else {
    await compileRef.update(recompiled(compileDoc.data(), now));
  }
  return id;
};

const buildCompileGet = ({ db }) => async ({ id, auth }) => {
  const compileRef = db.doc(`compiles/${id}`);
  const compileDoc = await compileRef.get();
  if (!compileDoc.exists) {
    return undefined;
  }
  const currentData = compileDoc.data();
  const updateData = recompiled(currentData, new Date().toISOString());
  await compileRef.update(updateData);
  // What the doc now holds, without reading it back.
  return decodeCompileData({ ...currentData, ...updateData });
};

export const buildCompileStorer = () => {
  const db = admin.firestore();
  const create = buildCompileCreate({ db });
  const get = buildCompileGet({ db });
  return { create, get };
};
