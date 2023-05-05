import { NotFoundError } from "@graffiticode/common/src/errors.js";
import admin from "firebase-admin";
import { getFirestore } from "../../firebase.js";

const buildList = ({ db }) => async () => {
  const query = db.collection("keys").orderBy("createdAt", "desc");
  const querySnapshot = await query.get();
  const ret = [];
  querySnapshot.forEach(snapshot => {
    const kid = snapshot.id;
    ret.push({ kid, ...snapshot.data() });
  });
  return ret;
};

const buildCreate = ({ db }) => async ({ alg, privateJwk, publicJwk }) => {
  const keyRef = await db.collection("keys").add({
    alg,
    privateJwk,
    publicJwk,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const kid = keyRef.id;
  return kid;
};

const buildSetCurrent = ({ db }) => async (kid) => {
  const keyDoc = await db.doc(`keys/${kid}`).get();
  if (!keyDoc.exists) {
    throw new NotFoundError(`key ${kid} does not exist`);
  }
  await db.doc("keys/current").set({ kid });
};

const buildGetCurrent = ({ db }) => async () => {
  const currentDoc = await db.doc("keys/current").get();
  if (!currentDoc.exists) {
    throw new NotFoundError("no current key");
  }
  const kid = currentDoc.get("kid");
  const keyDoc = await db.doc(`keys/${kid}`).get();
  if (!keyDoc.exists) {
    throw new NotFoundError(`current key ${kid} does not exist`);
  }
  return { kid, ...keyDoc.data() };
};

export const buildFirestoreKeyStorer = () => {
  const db = getFirestore();

  const list = buildList({ db });
  const create = buildCreate({ db });

  const setCurrent = buildSetCurrent({ db });
  const getCurrent = buildGetCurrent({ db });

  return { list, create, setCurrent, getCurrent };
};
