import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
  // --update-secrets only adds, so a secret mounted by an earlier release
  // carries into new revisions until it is removed explicitly.
  if (config.removeSecrets?.length) args.push(`--remove-secrets=${config.removeSecrets.join(",")}`);
  return args;
}

// The tagged candidate's URL, and the headers that let the deployer invoke it
// (Cloud Run IAM only; application credentials are the verifier's business).
async function candidateAccess(config, service, id, cloud) {
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
  return { base, headers };
}

export async function smokeCheck(config, service, id, { cloud, fetch: request = fetch }) {
  const { base, headers } = await candidateAccess(config, service, id, cloud);
  for (const check of config.smoke) {
    const url = new URL(check.path, base);
    requireValue(url.origin === base.origin, "Smoke check must stay on the candidate origin");
    // @ts-expect-error TS-MIGRATE: headers object built dynamically
    const response = await request(url, { headers, redirect: "error", signal: AbortSignal.timeout(30000) });
    requireValue(response.status === check.status, `Smoke check ${check.path}: expected ${check.status}, got ${response.status}`);
    const body = await response.text();
    if (check.bodyIncludes) requireValue(body.includes(check.bodyIncludes), `Smoke check ${check.path}: response did not match`);
  }
}

// Runs the service's verify module against the candidate, before promotion.
// The module is loaded from the release's captured snapshot (the hashed copy
// that was built), never from the working tree, and its sha256 is recorded in
// the receipt before it runs. Its default export receives the candidate and
// must resolve; any rejection fails the release with traffic unchanged. It
// runs on the deployer's machine with the deployer's gcloud credentials
// (`cloud`), and can import only Node built-ins and other snapshot files.
export async function verifyCandidate(config, service, id, source, receipt, { cloud, fetch: request = fetch, log = () => {}, persist = async () => {} }) {
  const file = path.join(source.dir, "source", config.verify.module);
  const sha256 = createHash("sha256").update(await readFile(file)).digest("hex");
  receipt.verify = { module: config.verify.module, sha256 };
  await persist();
  const { default: verify } = await import(pathToFileURL(file).href);
  requireValue(typeof verify === "function", `Verify module ${config.verify.module} must export a default function`);
  const { base, headers } = await candidateAccess(config, service, id, cloud);
  // @ts-expect-error TS-MIGRATE: callee ignores the argument; checkJs infers no parameters
  log(`Verifying the candidate with ${config.verify.module} (${sha256.slice(0, 12)})…`);
  await verify({ candidateUrl: base, serviceUrl: service.status.url, headers, config, cloud, fetch: request, log });
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
  requireValue(!config.verify || source.files.includes(config.verify.module), `Verify module ${config.verify?.module} is missing from the source snapshot`);
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
    if (config.verify) await verifyCandidate(config, candidate, id, source, receipt, { ...deps, persist });
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
    // Released either way; a failure here is reported, not undone.
    if (config.retireTags) {
      try {
        receipt.retiredTags = await retireTags(context, { cloud, log, keep: [receipt.id] });
      } catch (error) {
        receipt.tagRetirementError = error.message;
        log(`WARNING: released, but stale tags remain (${error.message}). Run: npm run deploy -- retire-tags ${config.service}`);
      }
      await persist();
    }
    return receipt;
  } catch (error) {
    receipt.failedAt = receipt.status;
    receipt.status = "failed";
    receipt.error = error.message;
    await persist();
    throw error;
  }
}

// Tags on revisions that serve no traffic, except those in `keep`. A tag URL
// reaches its revision directly, so an old revision of a protected service
// stays callable through its tag after promotion (capability plan W0).
export function staleTags(service, keep = []) {
  const serving = new Set(Object.keys(traffic(service)));
  return (service.status?.traffic || [])
    .filter(entry => entry.tag && !keep.includes(entry.tag) && !serving.has(entry.revisionName))
    .map(entry => entry.tag);
}

// Removes stale tags without touching traffic, and verifies both. Rollback
// targets revision names, not tags, so it keeps working.
export async function retireTags(context, { cloud, log, keep = [] }) {
  const { config } = context;
  const before = await cloud(["run", "services", "describe", config.service]);
  const tags = staleTags(before, keep);
  if (!tags.length) {
    log("No stale tags.");
    return [];
  }
  log(`Retiring ${tags.length} tag(s) on revisions that serve no traffic: ${tags.join(", ")}`);
  await cloud(["run", "services", "update-traffic", config.service, `--remove-tags=${tags.join(",")}`]);
  const after = await cloud(["run", "services", "describe", config.service]);
  requireValue(same(traffic(after), traffic(before)), "Traffic changed while retiring tags; inspect the service");
  const left = staleTags(after, keep).filter(tag => tags.includes(tag));
  requireValue(left.length === 0, `Tags could not be retired: ${left.join(", ")}`);
  return tags;
}

// When a revision was released, from its release id (`<service>-r<base36 ms>-<hex>`),
// or null for a revision this CLI did not create (it predates any baseline).
export function releaseTime(service, revisionName) {
  const match = new RegExp(`^${service}-r([0-9a-z]+)-[0-9a-f]{6}$`).exec(revisionName ?? "");
  return match ? parseInt(match[1], 36) : null;
}

// The revisions older than the service's milestone baseline (capability plan
// W0): the first release carrying the current security guarantees. Running
// below it gives those guarantees up.
export function belowBaseline(config, revisionNames) {
  if (!config.baseline) return [];
  const floor = releaseTime(config.service, `${config.service}-${config.baseline.release}`);
  return revisionNames.filter(name => {
    const at = releaseTime(config.service, name);
    return at === null || at < floor;
  });
}

// What must hold before protected execution is switched back on: no tag still
// reaches a non-serving revision (when the service retires tags), and nothing
// serving is below the baseline. Read-only.
export async function releaseCheck(context, { cloud }) {
  const { config } = context;
  const service = await cloud(["run", "services", "describe", config.service]);
  const serving = Object.keys(traffic(service));
  const result = {
    service: config.service,
    serving,
    staleTags: config.retireTags ? staleTags(service) : [],
    baseline: config.baseline ?? null,
    belowBaseline: belowBaseline(config, serving),
  };
  return { ...result, ok: result.staleTags.length === 0 && result.belowBaseline.length === 0 };
}

export async function rollback(context, receipt, { cloud, log, allowBelowBaseline = false }) {
  const { config, environment } = context;
  requireValue(receipt.version === 1 && receipt.project === config.project && receipt.region === config.region && receipt.service === config.service && receipt.environment === environment, "Release receipt does not match the deployment target");
  requireValue(receipt.revision && receipt.previousTraffic, "Receipt has no rollback target");
  const sum = Object.values(receipt.previousTraffic).reduce((a, b) => a + b, 0);
  requireValue(sum === 100 && Object.entries(receipt.previousTraffic).every(([k, v]) => /^[a-z][a-z0-9-]+$/.test(k) && Number.isInteger(v) && v > 0), "Invalid rollback traffic in receipt");
  const current = await cloud(["run", "services", "describe", config.service]);
  requireValue(same(traffic(current), { [receipt.revision]: 100 }), "Traffic no longer belongs exclusively to this release; refusing to overwrite a newer deployment");
  const below = belowBaseline(config, Object.keys(receipt.previousTraffic));
  requireValue(below.length === 0 || allowBelowBaseline,
    `Rollback target ${below.join(", ")} is below the ${config.baseline?.milestone} baseline (${config.baseline?.release}). ` +
    "Pass --below-baseline only with protected execution switched off; it cannot be switched back on until the service is at or above the baseline again.");
  log(`Restoring traffic to ${pairs(receipt.previousTraffic)}…`);
  await cloud(["run", "services", "update-traffic", config.service, `--to-revisions=${pairs(receipt.previousTraffic)}`]);
  const final = await cloud(["run", "services", "describe", config.service]);
  requireValue(same(traffic(final), receipt.previousTraffic), "Rollback traffic could not be verified");
  return { ...receipt, status: "rolled-back", rolledBackAt: new Date().toISOString(), ...(below.length ? { rolledBackBelowBaseline: below } : {}) };
}

export async function readReceipt(root, id) {
  return JSON.parse(await readFile(path.join(root, ".gc-deploy", "releases", `${id}.json`), "utf8"));
}
