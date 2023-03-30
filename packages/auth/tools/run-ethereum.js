import ethUtil from "@ethereumjs/util";
import bent from "bent";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { randomBytes } from "node:crypto";
import { createSignature } from "../src/services/ethereum.js";

// const baseUrl = "http://localhost:4100";
const baseUrl = "https://auth.graffiticode.org";

const getJson = bent(baseUrl, "GET", "json");
const postJson = bent(baseUrl, "POST", "json");

const jwks = createRemoteJWKSet(new URL(`${baseUrl}/certs`));

const rotateKey = () => postJson(`/certs`);

const getNonce = async ({ address }) => {
  const { status, error, data } = await getJson(`/authenticate/ethereum/${address}`);
  if (status !== "success") {
    throw new Error(error.message);
  }
  return data;
};

const authenticateWithEthereum = async ({ address, privateKey, nonce }) => {
  const signature = createSignature({ privateKey, nonce });
  const { status, error, data } = await postJson(`/authenticate/ethereum/${address}`, { nonce, signature });
  if (status !== "success") {
    throw new Error(error.message);
  }
  return data;
};

const authenticateWithRefreshToken = async ({ refreshToken }) => {
  const { status, error, data } = await postJson(`/authenticate/refreshToken`, { refreshToken });
  if (status !== "success") {
    throw new Error(error.message);
  }
  return data;
};

const validateAccessToken = async ({ accessToken }) => {
  const { payload: { sub }, protectedHeader: { kid } } = await jwtVerify(accessToken, jwks, { issuer: "urn:graffiticode:auth" });
  console.log(`Valid access token for uid ${sub} signed by key ${kid}`);
};

const run = async ({ privateKey }) => {
  const address = ethUtil.privateToAddress(privateKey).toString("hex");
  const nonce = await getNonce({ address });

  let { refreshToken, accessToken: at1 } = await authenticateWithEthereum({ address, privateKey, nonce });
  await validateAccessToken({ accessToken: at1 });

  await new Promise(r => setTimeout(r, 5000));

  const { accessToken: at2 } = await authenticateWithRefreshToken({ refreshToken });
  await validateAccessToken({ accessToken: at2 });
};

const handleError = err => {
  if (err.name === "StatusError") {
    console.error(err.message);
    console.error(err.statusCode);
    console.error(err.headers);
  } else {
    console.error(err);
  }
};

const runs = [
  // rotateKey().catch(handleError)
];
for (let i = 0; i < 100; i++) {
  runs.push(
    run({ privateKey: randomBytes(32) })
      .catch(handleError)
  );
}

Promise.all(runs).catch(handleError);
