// Broker service entry point (Cloud Run, project graffiticode).
//
//   PORT                    listen port (default 8080)
//   BROKER_FIRESTORE_DB     named Firestore database (default "broker")
//   BROKER_SECRET_KEY       32-byte key sealing connection secrets (Secret Manager; broker only)
//   POLICY_KMS_KEY_VERSION  the policy signing key version (public key only is read)
//   POLICY_KMS_KID          its key id
//   BROKER_CALLERS          caller map (see @graffiticode/policy config.js)
//   LEARNOSITY_DOMAIN       consumer domain for signed requests (e.g. l0176.graffiticode.org)
//   LEARNOSITY_DATA_API     Data API base URL (default https://data.learnosity.com/v2025.2.LTS)
//   AUDIT_PSEUDONYM_SECRET  HMAC secret for pseudonymous audit ids

import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import { OAuth2Client } from "google-auth-library";
import { importSPKI, exportJWK } from "jose";
import LearnositySDK from "learnosity-sdk-nodejs";
import {
  createCallerIdentity,
  buildGoogleIdTokenVerifier,
  createAudit,
  createPseudonymizer,
  requireEnv,
  parseCallers,
  auditSink
} from "@graffiticode/policy";
import {
  createBroker,
  createBrokerApp,
  buildOperations,
  createSecretBox,
  createFirestoreOnceStore,
  createFirestoreReceiptStore,
  createFirestoreSecretStore
} from "./index.js";
import { buildLearnosityDataApi } from "./learnosity.js";

const env = process.env;
const box = createSecretBox({ key: requireEnv(env, "BROKER_SECRET_KEY") });
const keyVersionName = requireEnv(env, "POLICY_KMS_KEY_VERSION");
const kid = requireEnv(env, "POLICY_KMS_KID");
const callers = parseCallers(requireEnv(env, "BROKER_CALLERS"));
const domain = requireEnv(env, "LEARNOSITY_DOMAIN");
const audit = createAudit({ sink: auditSink, pseudonymize: createPseudonymizer({ secret: requireEnv(env, "AUDIT_PSEUDONYM_SECRET") }) });

const app = admin.apps.length ? admin.app() : admin.initializeApp();
const db = getFirestore(app, env.BROKER_FIRESTORE_DB || "broker");

// Execution tokens are verified against the policy key's PUBLIC half, read
// from KMS (the broker holds publicKeyViewer, never signer).
const [publicKey] = await new KeyManagementServiceClient().getPublicKey({ name: keyVersionName });
const jwks = { keys: [{ ...(await exportJWK(await importSPKI(publicKey.pem, "ES256"))), kid, alg: "ES256", use: "sig" }] };

const secrets = createFirestoreSecretStore(db, { box });
const broker = createBroker({
  jwks,
  audit,
  secrets,
  once: createFirestoreOnceStore(db),
  receipts: createFirestoreReceiptStore(db),
  operations: buildOperations({
    sdk: new LearnositySDK(),
    domain,
    dataApi: buildLearnosityDataApi({ baseUrl: env.LEARNOSITY_DATA_API || "https://data.learnosity.com/v2025.2.LTS" })
  })
});
const server = createBrokerApp({
  broker,
  secrets,
  audit,
  identifyCaller: createCallerIdentity({
    verifyIdToken: buildGoogleIdTokenVerifier({ OAuth2Client }),
    audience: "urn:graffiticode:broker",
    callers
  })
});
const port = Number(env.PORT || 8080);
server.listen(port, () => console.log(`broker listening on ${port}`));
