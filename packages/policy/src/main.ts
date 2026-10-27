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
//   POLICY_SYSTEM_CONNECTIONS  optional backend -> system connection id (see config.js)
//   SYSTEM_SIGNINGS_PER_MINUTE, SYSTEM_SIGNINGS_BURST  optional; this instance's bucket on
//                           system preview mints (rate-limit.js; defaults 120 and 60)
//   PROTECTED_EXECUTION     optional; "disabled" hard-disables protected execution.
//                           Otherwise controls/protected-execution in this database
//                           decides, and a missing flag means off (see maintenance.js)

import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import { OAuth2Client, GoogleAuth } from "google-auth-library";
import { importSPKI, exportJWK } from "jose";
import { createClient as createAuthClient } from "@graffiticode/auth/client";
import {
  createPolicy,
  createPolicyApp,
  verifyUserWithRetry,
  createConnectionManager,
  createCallerIdentity,
  buildGoogleIdTokenVerifier,
  createKmsSigner,
  createFirestoreConnectionStore,
  createFirestoreInvocationStore,
  createFirestorePublicationStore,
  createFirestoreGrantStore,
  createBrokerAdminClient,
  createAudit,
  createPseudonymizer,
  createProtectedSwitch,
  createFirestoreFlagReader,
  parseHardDisable
} from "./index.js";
import { requireEnv, parseCallers, parseSystemConnections, refuseRemovedSettings, parseMinContractVersion, parseSystemSigningLimits, auditSink, createIdTokenSource } from "./config.js";
import { createFirestoreApprovals, createFirestoreLeaseFence } from "./revisions.js";

const env = process.env;
const keyVersionName = requireEnv(env, "POLICY_KMS_KEY_VERSION");
const kid = requireEnv(env, "POLICY_KMS_KID");
const callers = parseCallers(requireEnv(env, "POLICY_CALLERS"));
const authUrl = requireEnv(env, "AUTH_URL");
const brokerUrl = requireEnv(env, "BROKER_URL");
const auditSecret = requireEnv(env, "AUDIT_PSEUDONYM_SECRET");
const systemConnections = parseSystemConnections(env.POLICY_SYSTEM_CONNECTIONS);
refuseRemovedSettings(env);
// Contract v2 (W4): 1 until the cutover raises it.
const minContractVersion = parseMinContractVersion(env.POLICY_MIN_CONTRACT_VERSION);
const systemSigning = parseSystemSigningLimits(env);

const app = admin.apps.length ? admin.app() : admin.initializeApp();
const db = getFirestore(app, env.POLICY_FIRESTORE_DB || "policy");
// Approved compiler revisions: written by the deploy identity, read-only here
// (IAM review, Step 11).
const revisionsDb = getFirestore(app, env.POLICY_REVISIONS_DB || "revisions");
const kms = new KeyManagementServiceClient();

// The public half comes from KMS; the private half never leaves it.
const [publicKey] = await kms.getPublicKey({ name: keyVersionName });
const publicJwk = { ...(await exportJWK(await importSPKI(publicKey.pem, "ES256"))), kid, alg: "ES256", use: "sig" };
const publicJwks = { keys: [publicJwk] };

const verifyIdToken = buildGoogleIdTokenVerifier({ OAuth2Client });
const audit = createAudit({ sink: auditSink, pseudonymize: createPseudonymizer({ secret: auditSecret }) });
const connections = createFirestoreConnectionStore(db);
const signer = createKmsSigner({ kms, keyVersionName, kid });
const invocations = createFirestoreInvocationStore(db);
const publications = createFirestorePublicationStore(db);
const grants = createFirestoreGrantStore(db);
const protectedSwitch = createProtectedSwitch({ hardDisabled: parseHardDisable(env.PROTECTED_EXECUTION), readFlag: createFirestoreFlagReader(db) });
const idToken = createIdTokenSource({ GoogleAuth });
const brokerAdmin = createBrokerAdminClient({ brokerUrl, idToken });
const policy = createPolicy({
  brokerReconcile: brokerAdmin.reconcile,
  signer,
  jwks: publicJwks,
  connections,
  invocations,
  publications,
  grants,
  systemConnections,
  protectedSwitch,
  audit,
  approvals: createFirestoreApprovals(revisionsDb),
  fence: createFirestoreLeaseFence(db),
  minContractVersion,
  systemSigning,
});
const manager = createConnectionManager({ connections, grants, audit, systemConnections, brokerAdmin });
const authClient = createAuthClient(authUrl);
const verifyUser = verifyUserWithRetry(async token => ({ uid: (await authClient.verifyToken(token)).uid }));

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
