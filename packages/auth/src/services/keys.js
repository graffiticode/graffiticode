import { NotFoundError } from "@graffiticode/common/src/errors.js";
import { exportJWK, generateKeyPair } from "jose";

export const generateKey = async (alg = "ES256") => {
  const { privateKey, publicKey } = await generateKeyPair(alg);
  const [privateJwk, publicJwk] = await Promise.all([exportJWK(privateKey), exportJWK(publicKey)]);
  return { alg, privateJwk, publicJwk };
};

const buildRotateKey = ({ keyStorer }) => async () => {
  const key = await generateKey();
  const kid = await keyStorer.create(key);
  await keyStorer.setCurrent(kid);
  console.log(`Set current key: ${kid}`);
};

const buildGetCurrentKey = ({ keyStorer, rotateKey }) => {
  let rotateKeyProm = null;
  return async () => {
    try {
      return await keyStorer.getCurrent();
    } catch (err) {
      if (err instanceof NotFoundError) {
        if (!rotateKeyProm) {
          console.warn("Missing current key, performing key rotation");
          rotateKeyProm = rotateKey();
          rotateKeyProm
            .catch(err => console.error(`Failed to rotate signing key:\n${err.message}`))
            .then(() => {
              rotateKeyProm = null;
            });
        }
        await rotateKeyProm;
        return await keyStorer.getCurrent();
      }
      throw err;
    }
  };
};

const buildGetPublicCerts = ({ keyStorer }) => async () => {
  let keys = await keyStorer.list();
  keys = keys.map(({ kid, alg, publicJwk }) => {
    return { ...publicJwk, kid, alg, use: "sig" };
  });
  return keys;
};

export const buildKeysService = ({ keyStorer }) => {
  const rotateKey = buildRotateKey({ keyStorer });
  const getCurrentKey = buildGetCurrentKey({ keyStorer, rotateKey });
  const getPublicCerts = buildGetPublicCerts({ keyStorer });
  return { rotateKey, getCurrentKey, getPublicCerts };
};
