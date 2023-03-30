import admin from "firebase-admin";
import { NotFoundError } from "../../errors/http.js";
import { generateNonce } from "../../utils.js";

const buildList = ({ keys }) => async () => {
  const ret = [];
  keys.forEach((keyData, kid) => {
    if (kid !== "current") {
      ret.push({ kid, ...keyData });
    }
  });
  ret.sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
  return ret;
};

const buildCreate = ({ keys }) => async ({ alg, privateJwk, publicJwk }) => {
  const kid = await generateNonce(16);
  keys.set(kid, {
    alg,
    privateJwk,
    publicJwk,
    createdAt: admin.firestore.Timestamp.now()
  });
  return kid;
};

const buildSetCurrent = ({ keys }) => async (kid) => {
  if (!keys.has(kid)) {
    throw new NotFoundError(`key ${kid} does not exist`);
  }
  keys.set("current", kid);
};

const buildGetCurrent = ({ keys }) => async () => {
  if (!keys.has("current")) {
    throw new NotFoundError("no current key");
  }
  const kid = keys.get("current");
  if (!keys.has(kid)) {
    throw new NotFoundError(`current key ${kid} does not exist`);
  }
  const keyData = keys.get(kid);
  return { kid, ...keyData };
};

export const buildMemoryKeyStorer = () => {
  const keys = new Map();

  const list = buildList({ keys });
  const create = buildCreate({ keys });

  const setCurrent = buildSetCurrent({ keys });
  const getCurrent = buildGetCurrent({ keys });

  return { list, create, setCurrent, getCurrent };
};
