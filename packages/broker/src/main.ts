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
//   POLICY_URL              policy service URL: Broker asks authorize-execution before
//                           each effect, as its own service account (the `broker`
//                           caller role in Policy's POLICY_CALLERS)
//   BROKER_PROVIDER_CALL_TIMEOUT_MS, BROKER_EXECUTION_DEADLINE_MS, BROKER_AUTHORIZE_TIMEOUT_MS
//                           optional time limits (see limits.js; defaults 10 s, 30 s, 5 s)
//   PROTECTED_EXECUTION     optional; "disabled" hard-disables execution. Otherwise
//                           controls/protected-execution in this database decides, and
//                           a missing flag means off (@graffiticode/policy maintenance.js)
//   BROKER_ENABLED_GATED_OPERATIONS  optional enabled gated operations, e.g. ["learnosity.sign-author"]
//                           (see @graffiticode/policy config.js; empty in production until AT-10 evidence)

import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import { OAuth2Client, GoogleAuth } from "google-auth-library";
import { importSPKI, exportJWK } from "jose";
import LearnositySDK from "learnosity-sdk-nodejs";
import {
  createCallerIdentity,
  buildGoogleIdTokenVerifier,
  createAudit,
  createPseudonymizer,
  requireEnv,
  parseCallers,
  parseEnabledGatedOperations,
  auditSink,
  createProtectedSwitch,
  createFirestoreFlagReader,
  parseHardDisable,
  parseMinContractVersion,
  createIdTokenSource
} from "@graffiticode/policy";
import {
  createBroker,
  createBrokerApp,
  buildOperations,
  createSecretBox,
  createFirestoreOnceStore,
  createFirestoreReceiptStore,
  createFirestoreSecretStore,
  createFirestoreActivityStore,
  parseLimits,
  buildPolicyAuthorizer
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
  activity: createFirestoreActivityStore(db),
  limits: parseLimits(env),
  // Contract v2 (W4): 1 until the cutover raises it.
  minContractVersion: parseMinContractVersion(env.BROKER_MIN_CONTRACT_VERSION, "BROKER_MIN_CONTRACT_VERSION"),
  protectedSwitch: createProtectedSwitch({ hardDisabled: parseHardDisable(env.PROTECTED_EXECUTION), readFlag: createFirestoreFlagReader(db) }),
  authorize: buildPolicyAuthorizer({ policyUrl: requireEnv(env, "POLICY_URL"), idToken: createIdTokenSource({ GoogleAuth }) }),
  operations: buildOperations({
    sdk: new LearnositySDK(),
    domain,
    enabledGated: parseEnabledGatedOperations(env.BROKER_ENABLED_GATED_OPERATIONS),
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
