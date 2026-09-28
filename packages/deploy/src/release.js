import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { requireValue } from "./config.js";

export function traffic(service) {
  const totals = {};
  for (const entry of service.status?.traffic || []) {
    if (entry.percent > 0) {
      requireValue(entry.revisionName, "Traffic has no resolved revision name");
      totals[entry.revisionName] = (totals[entry.revisionName] || 0) + entry.percent;
    }
  }
  requireValue(Object.values(totals).reduce((a, b) => a + b, 0) === 100, "Expected an existing service with 100% resolved traffic; bootstrap it separately");
  return Object.fromEntries(Object.entries(totals).sort());
}
const fingerprint = service => JSON.stringify([service.metadata?.generation, service.spec, traffic(service)]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pairs = values => Object.entries(values).map(([k, v]) => `${k}=${v}`).join(",");
const envFlag = values => {
  let delimiter = "|";
  while (Object.values(values).some(v => v.includes(delimiter))) delimiter += "|";
  return `^${delimiter}^${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(delimiter)}`;
};

export function buildConfig(config, image) {
  return {
    steps: [...config.steps, { name: "gcr.io/cloud-builders/docker", args: ["build", "-t", image, "-f", config.dockerfile, "."] }],
    images: [image],
    serviceAccount: `projects/${config.project}/serviceAccounts/${config.buildServiceAccount}`,
    options: { requestedVerifyOption: "VERIFIED", logging: "GCS_ONLY", defaultLogsBucketBehavior: "REGIONAL_USER_OWNED_BUCKET" },
    timeout: "1800s",
  };
}

export function deployArgs(config, receipt) {
  const args = ["run", "deploy", config.service, `--image=${receipt.image}`, `--port=${config.port}`,
    `--service-account=${config.runtimeServiceAccount}`, "--no-traffic", `--tag=${receipt.id}`,
    `--revision-suffix=${receipt.id}`, `--labels=gc-release=${receipt.id},commit-sha=${receipt.commit}`];
  if (Object.keys(config.env || {}).length) args.push(`--update-env-vars=${envFlag(config.env)}`);
  if (Object.keys(config.secrets || {}).length) args.push(`--update-secrets=${pairs(config.secrets)}`);
  return args;
}

export async function smokeCheck(config, service, id, { cloud, fetch: request = fetch }) {
  const target = service.status.traffic.find(entry => entry.tag === id);
  requireValue(target?.url && target.revisionName === `${config.service}-${id}`, "Candidate tag does not point to the expected revision");
  const base = new URL(target.url);
  requireValue(base.protocol === "https:" && base.hostname.endsWith(".run.app"), "Unexpected candidate URL");
  const headers = {};
  if (config.access === "private") {
    requireValue(config.smokeServiceAccount, "Private smoke checks require smokeServiceAccount");
    const token = await cloud(["auth", "print-identity-token", `--impersonate-service-account=${config.smokeServiceAccount}`, `--audiences=${service.status.url}`, "--include-email"], { json: false });
    headers["X-Serverless-Authorization"] = `Bearer ${token}`;
  }
  for (const check of config.smoke) {
    const url = new URL(check.path, base);
    requireValue(url.origin === base.origin, "Smoke check must stay on the candidate origin");
    const response = await request(url, { headers, redirect: "error", signal: AbortSignal.timeout(30000) });
    requireValue(response.status === check.status, `Smoke check ${check.path}: expected ${check.status}, got ${response.status}`);
    const body = await response.text();
    if (check.bodyIncludes) requireValue(body.includes(check.bodyIncludes), `Smoke check ${check.path}: response did not match`);
  }
}

async function checkService(config, cloud) {
  const service = await cloud(["run", "services", "describe", config.service]);
  traffic(service);
  requireValue(service.spec?.template?.spec?.serviceAccountName === config.runtimeServiceAccount, "Runtime identity differs from deploy.json; provision/migrate the service separately first");
  const policy = await cloud(["run", "services", "get-iam-policy", config.service]);
  const publicAccess = policy.bindings?.some(b => b.role === "roles/run.invoker" && b.members?.some(m => ["allUsers", "allAuthenticatedUsers"].includes(m)));
  const anonymous = policy.bindings?.some(b => b.role === "roles/run.invoker" && !b.condition && b.members?.includes("allUsers"));
  const disabled = service.metadata?.annotations?.["run.googleapis.com/invoker-iam-disabled"] === "true";
  requireValue(config.access === "private" ? !publicAccess && !disabled : anonymous || disabled, "Service invocation policy differs from deploy.json; manage IAM separately");
  return service;
}

export async function release(context, source, deps) {
  const { config, configHash, environment } = context;
  const { cloud, log, save, temp } = deps;
  requireValue(!config.blocked, config.blocked);
  requireValue(!context.unresolved.length, `Set required variables: ${context.unresolved.join(", ")}`);
  log("Checking existing service, identity, and secret versions…");
  const initial = await checkService(config, cloud);
  for (const account of [config.buildServiceAccount, config.runtimeServiceAccount]) {
    await cloud(["iam", "service-accounts", "describe", account]);
  }
  for (const reference of Object.values(config.secrets || {})) {
    const [secret, version] = reference.split(":");
    const result = await cloud(["secrets", "versions", "describe", version, `--secret=${secret}`]);
    requireValue(result.state === "ENABLED", `Secret version ${reference} is not enabled`);
  }
  const id = `r${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const receipt = {
    version: 1,
    id,
    service: config.service,
    project: config.project,
    region: config.region,
    environment,
    createdAt: new Date().toISOString(),
    commit: source.commit,
    sourceHash: source.sourceHash,
    dirty: source.dirty,
    configHash,
    config,
    files: source.files,
    previousTraffic: traffic(initial),
    status: "building",
  };
  const persist = async () => save(receipt);
  await persist();
  try {
    const imageTag = `${config.image}:${id}`;
    const filename = path.join(temp, "build.json");
    await writeFile(filename, JSON.stringify(buildConfig(config, imageTag), null, 2));
    log(`Building ${id} from snapshot ${source.sourceHash.slice(0, 12)}…`);
    const submitted = await cloud(["builds", "submit", source.archive, `--config=${filename}`, "--async"]);
    requireValue(submitted.id, "Cloud Build did not return a build ID");
    receipt.buildId = submitted.id;
    await persist();
    await cloud(["builds", "log", receipt.buildId, "--stream"], { stream: true, json: false });
    const build = await cloud(["builds", "describe", receipt.buildId]);
    requireValue(build.status === "SUCCESS", `Build ${receipt.buildId} finished with ${build.status}; nothing deployed`);
    const artifact = build.results?.images?.find(image => image.name === imageTag);
    requireValue(artifact && /^sha256:[a-f0-9]{64}$/.test(artifact.digest), "Build returned no matching image digest");
    receipt.image = `${config.image}@${artifact.digest}`;
    receipt.buildSource = build.source;
    receipt.status = "built";
    await persist();
    const beforeDeploy = await cloud(["run", "services", "describe", config.service]);
    requireValue(fingerprint(beforeDeploy) === fingerprint(initial), "Service changed during build; refusing to deploy");
    log(`Deploying ${receipt.image} with no traffic…`);
    await cloud(deployArgs(config, receipt));
    receipt.revision = `${config.service}-${id}`;
    receipt.status = "candidate";
    await persist();
    const candidate = await cloud(["run", "services", "describe", config.service]);
    requireValue(candidate.status?.latestReadyRevisionName === receipt.revision, "Candidate is not the latest ready revision");
    requireValue(same(traffic(candidate), receipt.previousTraffic), "Traffic changed during candidate deployment; refusing promotion");
    log("Checking the candidate revision…");
    await (deps.smoke || smokeCheck)(config, candidate, id, deps);
    const beforePromotion = await cloud(["run", "services", "describe", config.service]);
    requireValue(fingerprint(beforePromotion) === fingerprint(candidate), "Service changed during verification; refusing promotion");
    receipt.status = "promoting";
    await persist();
    log(`Promoting ${receipt.revision}…`);
    await cloud(["run", "services", "update-traffic", config.service, `--to-revisions=${receipt.revision}=100`]);
    const final = await cloud(["run", "services", "describe", config.service]);
    requireValue(same(traffic(final), { [receipt.revision]: 100 }), "Promotion could not be verified; inspect service traffic before retrying");
    receipt.status = "released";
    receipt.url = final.status.url;
    await persist();
    return receipt;
  } catch (error) {
    receipt.failedAt = receipt.status;
    receipt.status = "failed";
    receipt.error = error.message;
    await persist();
    throw error;
  }
}

export async function rollback(context, receipt, { cloud, log }) {
  const { config, environment } = context;
  requireValue(receipt.version === 1 && receipt.project === config.project && receipt.region === config.region && receipt.service === config.service && receipt.environment === environment, "Release receipt does not match the deployment target");
  requireValue(receipt.revision && receipt.previousTraffic, "Receipt has no rollback target");
  const sum = Object.values(receipt.previousTraffic).reduce((a, b) => a + b, 0);
  requireValue(sum === 100 && Object.entries(receipt.previousTraffic).every(([k, v]) => /^[a-z][a-z0-9-]+$/.test(k) && Number.isInteger(v) && v > 0), "Invalid rollback traffic in receipt");
  const current = await cloud(["run", "services", "describe", config.service]);
  requireValue(same(traffic(current), { [receipt.revision]: 100 }), "Traffic no longer belongs exclusively to this release; refusing to overwrite a newer deployment");
  log(`Restoring traffic to ${pairs(receipt.previousTraffic)}…`);
  await cloud(["run", "services", "update-traffic", config.service, `--to-revisions=${pairs(receipt.previousTraffic)}`]);
  const final = await cloud(["run", "services", "describe", config.service]);
  requireValue(same(traffic(final), receipt.previousTraffic), "Rollback traffic could not be verified");
  return { ...receipt, status: "rolled-back", rolledBackAt: new Date().toISOString() };
}

export async function readReceipt(root, id) {
  return JSON.parse(await readFile(path.join(root, ".gc-deploy", "releases", `${id}.json`), "utf8"));
}
