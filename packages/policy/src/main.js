// Policy service entry point (Cloud Run, project graffiticode).
//
//   PORT                    listen port (default 8080)
//   POLICY_FIRESTORE_DB     named Firestore database (default "policy")
//   POLICY_KMS_KEY_VERSION  full CryptoKeyVersion name of the EC_SIGN_P256_SHA256 key
//   POLICY_KMS_KID          key id published in the JWKS
//   POLICY_CALLERS          caller map (see config.js)
//   AUTH_URL                auth service that verifies user tokens
//   BROKER_URL              broker service URL (credential provisioning)
//   AUDIT_PSEUDONYM_SECRET  HMAC secret for pseudonymous audit ids (Secret Manager)

import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import { OAuth2Client, GoogleAuth } from "google-auth-library";
import { importSPKI, exportJWK } from "jose";
import { createClient as createAuthClient } from "@graffiticode/auth/client";
import {
  createPolicy,
  createPolicyApp,
  createConnectionManager,
  createCallerIdentity,
  buildGoogleIdTokenVerifier,
  createKmsSigner,
  createFirestoreConnectionStore,
  createBrokerAdminClient,
  createAudit,
  createPseudonymizer
} from "./index.js";
import { requireEnv, parseCallers, auditSink, createIdTokenSource } from "./config.js";

const env = process.env;
const keyVersionName = requireEnv(env, "POLICY_KMS_KEY_VERSION");
const kid = requireEnv(env, "POLICY_KMS_KID");
const callers = parseCallers(requireEnv(env, "POLICY_CALLERS"));
const authUrl = requireEnv(env, "AUTH_URL");
const brokerUrl = requireEnv(env, "BROKER_URL");
const auditSecret = requireEnv(env, "AUDIT_PSEUDONYM_SECRET");

const app = admin.apps.length ? admin.app() : admin.initializeApp();
const db = getFirestore(app, env.POLICY_FIRESTORE_DB || "policy");
const kms = new KeyManagementServiceClient();

// The public half comes from KMS; the private half never leaves it.
const [publicKey] = await kms.getPublicKey({ name: keyVersionName });
const publicJwk = { ...(await exportJWK(await importSPKI(publicKey.pem, "ES256"))), kid, alg: "ES256", use: "sig" };
const publicJwks = { keys: [publicJwk] };

const verifyIdToken = buildGoogleIdTokenVerifier({ OAuth2Client });
const audit = createAudit({ sink: auditSink, pseudonymize: createPseudonymizer({ secret: auditSecret }) });
const connections = createFirestoreConnectionStore(db);
const signer = createKmsSigner({ kms, keyVersionName, kid });
const policy = createPolicy({ signer, jwks: publicJwks, connections, audit });
const idToken = createIdTokenSource({ GoogleAuth });
const manager = createConnectionManager({ connections, audit, brokerAdmin: createBrokerAdminClient({ brokerUrl, idToken }) });
const authClient = createAuthClient(authUrl);
const verifyUser = async token => ({ uid: (await authClient.verifyToken(token)).uid });

const server = createPolicyApp({
  policy,
  manager,
  identifyCaller: createCallerIdentity({ verifyIdToken, audience: "urn:graffiticode:policy", callers }),
  verifyUser,
  publicJwks,
  audit
});
const port = Number(env.PORT || 8080);
server.listen(port, () => console.log(`policy listening on ${port}`));
