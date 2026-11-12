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
//   --reconcile             reconcile the gateway write (W5, WRITE-02): Policy and
//                           Broker must have reconciliation; adds about 90 s, the
//                           write's deadline plus the grace period
//   --command               C6 (COMMANDS_L0176=on): also save through POST
//                           /command, as the console does: completed, the
//                           saved item in its view, the same command for the
//                           same key, its status URL, and a preview refused
//                           no-effects. With --reconcile, its key reconciles too.
//                           One more sandbox draft per run.
//   --l0185-tail            C3, with --command: also save through POST /command
//                           over an L0185 stage that fetches, so the save's
//                           pinned input comes from a fetch: completed, and the
//                           saved item in its view. One more sandbox draft per run.
//   --after-cutover        Policy runs MIN_CONTRACT_VERSION=2: v1-shaped
//                           sessions must be refused
//   --provider              AT-10 release-verify, on the gateway preview: signed by
//                           the attested preview consumer, Broker's expires,
//                           pinned type and session, no-store, and the
//                           attestation in date and naming BROKER_PREVIEW_CONNECTIONS
//   --attestation <file>    with --provider: the attestation file, when running
//                           from a checkout without .gc-deploy/provider
//   --no-saved-read         skip the saved read (READ-01): two views of the
//                           saved result through the connection (GET /data),
//                           each freshly signed, keeping the saved references
//   --no-audit-check        keep the saved read, but skip its audit observation
//                           (for an operator without log access; reported as
//                           skipped). Otherwise the run reads the window's
//                           security-audit records from Cloud Logging for
//                           120 s and fails on any write in it.
// The gateway's runtime account also mints the ID token for L0176's
// /preflight (audience urn:graffiticode:0176), under the same role.

import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { VERIFY_UID } from "../verify/auth.js";
import { runCanary } from "./lib/canary.js";
import { createDraftArchiver } from "./lib/canary-archive.js";
import { createCanaryEnv, loadDeployServices, languageRoute, routedRevision, revisionEnv, domainServices, http } from "./lib/canary-env.js";

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

const deploy = await loadDeployServices();
const authUrl = deploy.l0176.env.AUTH_URL;
// `parse` reads L0176's lexicon from the api URL, once it's known.
const { gcloud, serviceUrl, accessToken, idToken, parse } = createCanaryEnv({ uid, project, region, authUrl, apiUrl: () => config.apiUrl });

// --provider: Broker's preview settings from deploy.json, and the preview
// consumer's operator attestation (local, gitignored; see the runbook).
async function providerConfig() {
  const env = deploy.broker.env ?? {};
  const previewConnection = JSON.parse(env.BROKER_PREVIEW_CONNECTIONS ?? "{}").learnosity ?? null;
  // A release worktree has no local evidence: --attestation names the file.
  const file = flag("--attestation") ?? new URL("../.gc-deploy/provider/preview-consumer-attestation.json", import.meta.url).pathname;
  const attestation = await readFile(file, "utf8").then(JSON.parse, () => null);
  return { previewConnection, expiresMinutes: Number(env.BROKER_PREVIEW_EXPIRES_MINUTES ?? 10), attestation };
}

// How the api under test routes languages: the env of the revision its URL
// reaches (a staged release's tag, or the serving revision), and Cloud Run's
// domain mappings for languages routed through lNNNN.graffiticode.org.
// deploy.json can be ahead of what is deployed.
const apiUrl = flag("--api-url") ?? await serviceUrl("api");
const apiHost = new URL(apiUrl).hostname;
const apiTag = apiHost.includes("---") ? apiHost.split("---")[0] : null;
const apiService = JSON.parse(await gcloud(["run", "services", "describe", "api", `--region=${region}`, "--format=json"]));
const apiRevision = routedRevision(apiService, apiTag);
const apiEnv = apiRevision
  ? revisionEnv(JSON.parse(await gcloud(["run", "revisions", "describe", apiRevision, `--region=${region}`, "--format=json"])))
  : deploy.api?.env;
const domains = domainServices(JSON.parse(await gcloud(["beta", "run", "domain-mappings", "list", `--region=${region}`, "--format=json"])));
const route = lang => languageRoute(lang, apiEnv, domains);
// L0176's compiler is wherever that api routes it: l0176, or l0176r once it is
// switched (interpreter plan A5). Its runtime account mints the compiler's
// tokens, and its URL serves /preflight.
const l0176Service = route("0176").service;
const config = {
  apiUrl,
  policyUrl: deploy.l0176.env.POLICY_URL,
  brokerUrl: deploy.l0176.env.BROKER_URL,
  gatewayAccount: deploy.api.runtimeServiceAccount,
  compilerAccount: deploy[l0176Service].runtimeServiceAccount,
  consoleAccount: flag("--console-account") ?? "console-run@graffiticode-app.iam.gserviceaccount.com",
  connectionId,
  revocationProbe: !args.includes("--no-revocation-probe"),
  chainAdmission: args.includes("--chain-admission"),
  afterCutover: args.includes("--after-cutover"),
  reconcile: args.includes("--reconcile"),
  command: args.includes("--command"),
  l0185Tail: args.includes("--l0185-tail"),
  // D4: the api under test has retired L0176's compile-to-command bridge, so
  // saves go through POST /command and a compile that would save is refused.
  bridgeRetired: apiEnv?.BRIDGE_L0176 === "off",
  provider: args.includes("--provider") ? await providerConfig() : null,
  languageUrl: args.includes("--chain-admission") || args.includes("--after-cutover") ? await serviceUrl(l0176Service) : null,
  savedRead: !args.includes("--no-saved-read"),
  auditCheck: !args.includes("--no-audit-check"),
};
// The saved read's audit source: Policy's and Broker's security-audit records
// for the canary connection in a time window, from Cloud Logging.
const auditEvents = async ({ since, until, connectionId: conn }) => {
  const filter = [
    "resource.type=\"cloud_run_revision\"",
    "resource.labels.service_name=(\"policy\" OR \"broker\")",
    "jsonPayload.logName=\"security_audit\"",
    `jsonPayload.connectionId="${conn}"`,
    `timestamp>="${since}"`,
    `timestamp<="${until}"`,
  ].join(" AND ");
  const out = await gcloud(["logging", "read", filter, "--limit=1000", "--format=json"]);
  return (JSON.parse(out || "[]")).map(e => e.jsonPayload ?? {});
};
const retryFile = flag("--retry-state");
if (retryFile && !config.chainAdmission) {
  console.error("--retry-state needs --chain-admission");
  process.exit(2);
}
// The route comes from the deployed api, not deploy.json: the scheduled canary
// runs from an image whose baked deploy.json goes stale at every Rust cutover
// (L0000 on 2026-10-29 and L0176 on 2026-11-03 each failed the chain-admission
// checks until the image was rebuilt, while production was fine).
// The revision a language's compiles reach now: on the service the api under
// test routes it to, its tag's revision when the route names one, else the
// revision serving all of the service's traffic.
const servingRevision = async lang => {
  const { service, tag } = route(lang);
  return routedRevision(JSON.parse(await gcloud(["run", "services", "describe", service, `--region=${region}`, "--format=json"])), tag);
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
console.log(`canary ${uid} on ${connectionId} via ${config.apiUrl} (api ${apiRevision ?? "deploy.json"}; L0176 on ${l0176Service})`);
// Cleanup of the drafts this run saves, when the development organisation's
// Data API key is in the environment (scripts/lib/canary-archive.js).
let archiveDrafts = null;
if (process.env.LRN_SANDBOX_KEY && process.env.LRN_SANDBOX_SECRET) {
  const { default: LearnositySDK } = await import("learnosity-sdk-nodejs");
  archiveDrafts = createDraftArchiver({ sdk: new LearnositySDK(), key: process.env.LRN_SANDBOX_KEY, secret: process.env.LRN_SANDBOX_SECRET, domain: process.env.LRN_SANDBOX_DOMAIN || "l0176.graffiticode.org" });
}
const { ok, results } = await runCanary({ http, archiveDrafts, auditEvents, idToken, accessToken, parse, config, servingRevision, retryState, log: line => console.log(`  ${line}`) });
console.log(ok ? `canary passed (${results.length} checks)` : `canary FAILED (${results.filter(r => !r.ok).length} of ${results.length} checks)`);
process.exit(ok ? 0 : 1);
