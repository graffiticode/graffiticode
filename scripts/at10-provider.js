#!/usr/bin/env node
// The AT-10 provider harness (scripts/lib/at10-provider.js;
// docs/protected-execution.md, "AT-10 provider harness"). Measures what
// Learnosity enforces on what Graffiticode signs and saves, in the sandbox.
//
//   node scripts/at10-provider.js <case...> [--signer broker|raw] [--api questions|items] [--run]
//
// Without --run it prints the plan and touches nothing: no gcloud, no
// signing, no browser, no network. With --run:
//   - the broker signer signs through Policy and Broker as the canary does
//     (scripts/canary.js): the canary account's API key from Secret Manager
//     `canary-api-key`, and ID tokens for the gateway, compiler and console
//     runtime accounts (roles/iam.serviceAccountOpenIdTokenCreator on each);
//   - the raw signer, the Data API fixtures and the Question Editor preview
//     use the sandbox credential from the environment only:
//       set -a; . ~/.lrn-sandbox.env; set +a
//     (LRN_SANDBOX_KEY, LRN_SANDBOX_SECRET, LRN_SANDBOX_DOMAIN,
//     LRN_SANDBOX_KEY_SUFFIX). Any key not ending in LRN_SANDBOX_KEY_SUFFIX is
//     refused before anything is sent;
//   - the canary account: --uid, or CANARY_UID in the environment;
//   - the browser is playwright-core's Chromium: `npx playwright-core install
//     chromium` once, or --chromium <path> (or AT10_CHROMIUM) for an installed
//     Chrome.
// Evidence (facts only) goes to .gc-deploy/provider/at10-<timestamp>.json.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { VERIFY_UID } from "../verify/auth.js";
import { createCanaryEnv, loadDeployServices, http } from "./lib/canary-env.js";
import { main } from "./lib/at10-provider.js";

// The canary's connection (deploy.json's canary configuration). The canary
// account's uid isn't in the repository: --uid or CANARY_UID.
const CANARY_CONNECTION = "conn-686c62bc-b447-4dd8-bba8-60fd2b7a3cfd";

const brokerEnv = async opts => {
  const uid = opts.uid ?? process.env.CANARY_UID;
  if (!uid) throw new Error("the broker signer needs the canary account: --uid <uid> or CANARY_UID");
  if (uid === VERIFY_UID) throw new Error("the deploy-check account (VERIFY_UID) must never sign for AT-10");
  const connectionId = opts.connectionId ?? CANARY_CONNECTION;
  const deploy = await loadDeployServices();
  const env = createCanaryEnv({ uid, authUrl: deploy.l0176.env.AUTH_URL, apiUrl: () => config.apiUrl });
  const config = {
    apiUrl: await env.serviceUrl("api"),
    policyUrl: deploy.l0176.env.POLICY_URL,
    brokerUrl: deploy.l0176.env.BROKER_URL,
    gatewayAccount: deploy.api.runtimeServiceAccount,
    compilerAccount: deploy.l0176.runtimeServiceAccount,
    connectionId,
    languageUrl: await env.serviceUrl("l0176"),
  };
  const signerDeps = { http, idToken: env.idToken, accessToken: env.accessToken, parse: env.parse, config };
  return { signerDeps, caches: { http, apiUrl: config.apiUrl, userToken: await env.accessToken(), connectionId, parse: env.parse } };
};

const firestoreLister = async () => {
  const { initializeApp, applicationDefault } = await import("firebase-admin/app");
  const { getFirestore, FieldPath } = await import("firebase-admin/firestore");
  const deploy = await loadDeployServices();
  const app = initializeApp({ credential: applicationDefault(), projectId: "graffiticode" });
  const dbs = { api: getFirestore(app), policy: getFirestore(app, deploy.policy.env.POLICY_FIRESTORE_DB) };
  return async (db, collection, after, limit) => {
    let q = dbs[db].collection(collection).orderBy(FieldPath.documentId()).limit(limit);
    if (after) q = q.startAfter(after);
    return (await q.get()).docs.map(d => ({ id: d.id, data: d.data() }));
  };
};

const prompt = async question => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
};

const code = await main(process.argv.slice(2), {
  env: process.env,
  out: line => console.log(line),
  err: line => console.error(line),
  now: Date.now,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  prompt,
  fs: { readFile, writeFile, rename, mkdir },
  fetch: globalThis.fetch,
  makeRawSdk: async () => {
    const { default: LearnositySDK } = await import("learnosity-sdk-nodejs");
    return new LearnositySDK();
  },
  launchBrowser: async opts => {
    const { chromium } = await import("playwright-core");
    return chromium.launch({ headless: !opts.headed, executablePath: opts.chromium ?? process.env.AT10_CHROMIUM ?? undefined });
  },
  brokerEnv,
  firestoreLister,
});
process.exit(code);
