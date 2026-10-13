#!/usr/bin/env node
// The W0 canary (scripts/lib/canary.js): end-to-end protected execution as the
// dedicated canary account through its sandbox connection. Run it after a
// release of policy, broker, api or l0176, typically while protected execution
// is paused with the canary configured (docs/protected-execution.md).
//
//   node scripts/canary.js --uid <canary uid> --connection <canary connection id>
//
// Needs, with the operator's gcloud credentials:
//   - Secret Manager `canary-api-key` (project graffiticode): the canary
//     account's API key. Never VERIFY_UID's.
//   - permission to mint ID tokens for the gateway (api) and compiler (l0176)
//     runtime accounts (roles/iam.serviceAccountOpenIdTokenCreator on each),
//     for the direct token- and receipt-replay checks. Grant it for the
//     release window only if preferred. Minted through the IAM Credentials
//     API, not gcloud impersonation, so that role alone is enough.
//   - the same role on the console's runtime account
//     (console-run@graffiticode-app, or --console-account) for the W2
//     revocation probe, which narrows and restores the canary connection's
//     owner permissions through Policy's console routes. Before W2 is
//     released the probe can't pass; --no-revocation-probe skips it.
// It writes one draft item ("graffiticode-canary") to the sandbox item bank
// per run. Exits non-zero unless every check passes.
//
// W4 (chain admission; docs/protected-execution.md, "W4 activation and
// cutover"):
//   --chain-admission       the canary connection is in api's CHAIN_ADMISSION
//                           (canary or all): pinned admission, a denied final
//                           stage, and the direct path admitted as the gateway
//   --retry-state <file>    with --chain-admission: the first run records its
//                           write here; deploy L0176, then run again, and the
//                           second run retries that write across the deploy
//                           (the file is removed once it passes)
//   --after-cutover         Policy runs MIN_CONTRACT_VERSION=2: v1-shaped
//                           sessions must be refused
// The gateway's runtime account also mints the ID token for L0176's
// /preflight (audience urn:graffiticode:0176), under the same role.

import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { parser } from "@graffiticode/parser";
import { VERIFY_UID } from "../verify/auth.js";
import { run } from "../packages/deploy/src/process.js";
import { runCanary } from "./lib/canary.js";

const args = process.argv.slice(2);
const flag = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const uid = flag("--uid");
const connectionId = flag("--connection");
const project = flag("--project") ?? "graffiticode";
const region = flag("--region") ?? "us-central1";
if (!uid || !connectionId) {
  console.error("usage: node scripts/canary.js --uid <canary uid> --connection <canary connection id>");
  process.exit(2);
}
if (uid === VERIFY_UID) {
  console.error("the deploy-check account (VERIFY_UID) must never be the canary");
  process.exit(2);
}

const gcloud = async gcloudArgs => String(await run("gcloud", [...gcloudArgs, `--project=${project}`, "--quiet"])).trim();
const deploy = JSON.parse(await readFile(new URL("../deploy.json", import.meta.url), "utf8")).services;
const serviceUrl = name => gcloud(["run", "services", "describe", name, `--region=${region}`, "--format=value(status.url)"]);

const http = async ({ method, url, headers = {}, body }) => {
  const res = await fetch(url, { method, headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json };
};

const config = {
  apiUrl: flag("--api-url") ?? await serviceUrl("api"),
  policyUrl: deploy.l0176.env.POLICY_URL,
  brokerUrl: deploy.l0176.env.BROKER_URL,
  gatewayAccount: deploy.api.runtimeServiceAccount,
  compilerAccount: deploy.l0176.runtimeServiceAccount,
  consoleAccount: flag("--console-account") ?? "console-run@graffiticode-app.iam.gserviceaccount.com",
  connectionId,
  revocationProbe: !args.includes("--no-revocation-probe"),
  chainAdmission: args.includes("--chain-admission"),
  afterCutover: args.includes("--after-cutover"),
  languageUrl: args.includes("--chain-admission") || args.includes("--after-cutover") ? await serviceUrl("l0176") : null,
};
const retryFile = flag("--retry-state");
if (retryFile && !config.chainAdmission) {
  console.error("--retry-state needs --chain-admission");
  process.exit(2);
}
// The revision serving 100% of a language's traffic now.
const servingRevision = async lang => {
  const service = JSON.parse(await gcloud(["run", "services", "describe", `l${lang}`, `--region=${region}`, "--format=json"]));
  const full = (service.status?.traffic ?? []).find(t => t.percent === 100);
  return full?.revisionName ?? (full?.latestRevision ? service.status?.latestReadyRevisionName : null) ?? null;
};
const retryState = retryFile
  ? {
      load: async () => { try { return JSON.parse(await readFile(retryFile, "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw e; } },
      save: async value => {
        await mkdir(path.dirname(retryFile), { recursive: true });
        await writeFile(retryFile, `${JSON.stringify(value, null, 2)}\n`);
      },
      clear: async () => rm(retryFile, { force: true }),
    }
  : null;
const authUrl = deploy.l0176.env.AUTH_URL;

const accessToken = async () => {
  const key = await gcloud(["secrets", "versions", "access", "latest", "--secret=canary-api-key"]);
  const res = await http({ method: "POST", url: `${authUrl}/authenticate/api-key`, body: { token: key } });
  const token = res.json?.data?.accessToken;
  if (!token) throw new Error(`canary api key exchange failed: ${res.status}`);
  const verified = await http({ method: "POST", url: `${authUrl}/oauth/verify`, body: { idToken: token } });
  if (verified.json?.data?.uid !== uid) throw new Error(`the canary api key belongs to ${verified.json?.data?.uid ?? "nobody"}, not --uid ${uid}`);
  return token;
};

// Minted with the IAM Credentials API under the operator's own credentials,
// which needs only iam.serviceAccounts.getOpenIdToken (OpenIdTokenCreator).
// `gcloud auth print-identity-token --impersonate-service-account` first
// generates an access token for the account, which that role does not allow.
let operatorToken;
const idToken = async (account, audience) => {
  operatorToken ??= await gcloud(["auth", "print-access-token"]);
  const res = await http({
    method: "POST",
    url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${account}:generateIdToken`,
    headers: { Authorization: `Bearer ${operatorToken}` },
    body: { audience, includeEmail: true }
  });
  if (!res.json?.token) throw new Error(`minting an ID token for ${account} failed: ${res.status} ${res.json?.error?.message ?? ""}`);
  return res.json.token;
};

let lexicon;
const parse = async src => {
  if (!lexicon) {
    const res = await fetch(`${config.apiUrl}/L0176/lexicon.json`);
    const text = await res.text();
    lexicon = JSON.parse(text.substring(text.indexOf("{")));
  }
  return parser.parse(176, src, lexicon);
};

console.log(`canary ${uid} on ${connectionId} via ${config.apiUrl}`);
const { ok, results } = await runCanary({ http, idToken, accessToken, parse, config, servingRevision, retryState, log: line => console.log(`  ${line}`) });
console.log(ok ? `canary passed (${results.length} checks)` : `canary FAILED (${results.filter(r => !r.ok).length} of ${results.length} checks)`);
process.exit(ok ? 0 : 1);
