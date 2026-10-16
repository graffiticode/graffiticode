import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { requireValue } from "./config.js";
import { approvalRecord, reachableProblems, retainedTags } from "./revisions.js";

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
    `--revision-suffix=${receipt.id}`, `--labels=gc-release=${receipt.id},commit-sha=${receipt.commit},gc-dirty=${receipt.dirty ? "true" : "false"}`];
  // The revision's own identity, for a compiler to report in its preflight
  // manifest (capability plan W4): its release, and the digest it runs (known
  // before the revision exists, since every release deploys by digest).
  const imageDigest = receipt.image?.split("@")[1];
  const env = { ...(config.env || {}), GC_RELEASE: receipt.id, ...(imageDigest ? { GC_IMAGE_DIGEST: imageDigest } : {}), ...networkEnv(config.network) };
  args.push(`--update-env-vars=${envFlag(env)}`);
  const secrets = { ...(config.secrets || {}), ...(config.network ? { [config.network.ca.path]: config.network.ca.secret } : {}) };
  if (Object.keys(secrets).length) args.push(`--update-secrets=${pairs(secrets)}`);
  if (config.network) {
    // All of the revision's traffic goes through the compiler network (ISOLATE-01).
    args.push(`--network=${config.network.network}`, `--subnet=${config.network.subnet}`, "--vpc-egress=all-traffic", `--network-tags=${config.network.tags.join(",")}`);
  }
  // --update-secrets only adds, so a secret mounted by an earlier release
  // carries into new revisions until it is removed explicitly.
  if (config.removeSecrets?.length) args.push(`--remove-secrets=${config.removeSecrets.join(",")}`);
  // Likewise --update-env-vars keeps variables it isn't given: removeEnv
  // removes them (no name is in both; config.js refuses that).
  if (config.removeEnv?.length) args.push(`--remove-env-vars=${config.removeEnv.join(",")}`);
  if (config.minInstances !== undefined) args.push(`--min-instances=${config.minInstances}`);
  if (config.maxInstances !== undefined) args.push(`--max-instances=${config.maxInstances}`);
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
    // The first check usually lands on a cold instance, so a slow-starting
    // service (Next.js) raises its own timeoutMs; the default stays 30s.
    const response = await request(url, { headers, redirect: "error", signal: AbortSignal.timeout(check.timeoutMs ?? 30000) });
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

// Cloud Build's own status decides when a build is done; the log stream only
// shows progress. `gcloud builds log --stream` can outlive the build (it once
// held a release for an hour after a successful build), so once the build
// finishes the stream gets a grace period to print its tail, then is stopped.
// A stream that fails or never closes never fails or holds a release.
const FINISHED = ["SUCCESS", "FAILURE", "INTERNAL_ERROR", "TIMEOUT", "CANCELLED", "EXPIRED"];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {string} buildId
 * @param {{ cloud: Function, log?: (message: string) => void, streamLog?: (buildId: string) => { done: Promise<unknown>, stop: () => void }, sleep?: (ms: number) => Promise<unknown>, pollMs?: number, graceMs?: number }} deps
 */
export async function waitForBuild(buildId, { cloud, log = () => {}, streamLog, sleep = pause, pollMs = 10000, graceMs = 15000 }) {
  const stream = streamLog?.(buildId);
  const ended = stream?.done.then(() => {}, err => log(`(build log stream stopped: ${err.message})`));
  try {
    for (;;) {
      const build = await cloud(["builds", "describe", buildId]);
      if (FINISHED.includes(build.status)) {
        if (ended) await Promise.race([ended, sleep(graceMs)]);
        return build;
      }
      await sleep(pollMs);
    }
  } finally {
    stream?.stop();
  }
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
  for (const reference of [...Object.values(config.secrets || {}), ...(config.network ? [config.network.ca.secret] : [])]) {
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
    const build = await waitForBuild(receipt.buildId, deps);
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
    // A candidate that inherited a forbidden variable from the service's
    // template (one not listed in removeEnv) is never promoted.
    const forbidden = await forbiddenEnvProblems(context, [receipt.revision], { cloud });
    requireValue(forbidden.length === 0, `Candidate ${describeForbidden(forbidden)}; add it to removeEnv. Not promoted.`);
    // Cross-service requirements, both ways: every reachable revision of each
    // service this one requires meets the milestone, and the candidate meets
    // every milestone of this service that another requires.
    if (context.requires?.length || context.requiredBy?.length) {
      requireValue(deps.git, "Checking cross-service requirements needs the local Git history");
      const unmet = await requirementProblems(context, deps);
      requireValue(unmet.length === 0, `${describeRequirements(unmet)}. Not promoted.`);
      const breaks = await requiredByProblems(context, [receipt.revision], deps);
      requireValue(breaks.length === 0, `Candidate ${describeRequiredBy(breaks)}. Not promoted.`);
    }
    const beforePromotion = await cloud(["run", "services", "describe", config.service]);
    requireValue(fingerprint(beforePromotion) === fingerprint(candidate), "Service changed during verification; refusing promotion");
    // A pinnable revision is approved before it serves, so admission never sees
    // a serving revision without a record. If approval fails, nothing is
    // promoted.
    if (config.pinnable) {
      requireValue(deps.revisions, "A pinnable service needs the revisions store");
      const record = await deps.revisions.approve(approvalRecord(config, receipt, beforePromotion));
      receipt.approval = { ...record, approvedAt: record.approvedAt.toISOString() };
      await persist();
    }
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
        receipt.retiredTags = await retireTags(context, { cloud, log, keep: [receipt.id], revisions: deps.revisions });
        // When the removal was verified: no later than the old tags stopped
        // answering, so a wait measured from it (the W4 cutover's T) is safe.
        if (receipt.retiredTags.length) receipt.tagsRetiredAt = new Date().toISOString();
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
export async function retireTags(context, { cloud, log, keep = [], revisions = undefined }) {
  const { config } = context;
  const before = await cloud(["run", "services", "describe", config.service]);
  // A pinnable service keeps the tags of approved revisions: admitted plans
  // route to them. Only `retire` (scripts/revisions.js) removes those.
  if (config.pinnable) {
    requireValue(revisions, "A pinnable service needs the revisions store");
    keep = [...keep, ...retainedTags(before, await revisions.list())];
  }
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

// A revision's provenance, from the labels every release puts on it: the Git
// commit it was built from and whether the workspace was dirty. A revision
// without them was not made by this CLI (or predates provenance labels).
export async function provenanceOf(cloud, revisionName) {
  const revision = await cloud(["run", "revisions", "describe", revisionName]);
  const labels = revision.metadata?.labels ?? {};
  return { revision: revisionName, commit: labels["commit-sha"] ?? null, dirty: labels["gc-dirty"] ?? null };
}

// Does this revision carry the security guarantees of the milestone whose code
// is `commit`? Only if it was built cleanly from that commit or a descendant of
// it (capability plan W0). Neither the revision name nor its age counts: an
// old commit redeployed under a new release id does not qualify. `git` answers
// ancestry from the local history (fetch first).
export async function meetsMilestone(git, provenance, commit) {
  if (provenance.dirty !== "false" || !/^[0-9a-f]{40}$/.test(provenance.commit ?? "")) return false;
  return provenance.commit === commit || git.isAncestor(commit, provenance.commit);
}

// The revisions (of `names`) that do not meet the given baseline: "current" is
// the latest milestone, "first" the earliest (for a service that enforces the
// protected-execution switch, the one that introduced it).
export async function belowBaseline(context, names, { cloud, git }, which = "current") {
  const baselines = context.config.baselines ?? [];
  if (!baselines.length) return [];
  const { commit } = which === "first" ? baselines[0] : baselines[baselines.length - 1];
  const below = [];
  for (const name of names) {
    if (!(await meetsMilestone(git, await provenanceOf(cloud, name), commit))) below.push(name);
  }
  return below;
}

// ISOLATE-01 (W5 stage 4): what every revision of a networked compiler runs
// with. The proxy is its only route out; NO_PROXY exempts only the metadata
// server, which the runtime uses for its own identity and tokens; the
// inspection CA is mounted from Secret Manager and trusted by Node.
export const METADATA_ONLY = "169.254.169.254,metadata.google.internal";
export const NETWORK_ENV = Object.freeze(["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"]);
export function networkEnv(network) {
  if (!network) return {};
  return { HTTPS_PROXY: network.proxy, HTTP_PROXY: network.proxy, NO_PROXY: METADATA_ONLY, NODE_EXTRA_CA_CERTS: network.ca.path };
}

// The revisions among `names` that don't run with the network's settings, and
// why: wrong or missing network interface, egress not all-traffic, any proxy
// variable different (including NO_PROXY exempting more than the metadata
// server), or the CA not mounted from the configured secret at its path.
// Read from each revision itself, since an older revision keeps the settings
// it was deployed with.
export async function networkProblems(context, names, { cloud }) {
  const network = context.config.network;
  if (!network) return [];
  const want = networkEnv(network);
  const [secretName, secretVersion] = network.ca.secret.split(":");
  const caDir = path.posix.dirname(network.ca.path);
  const caFile = path.posix.basename(network.ca.path);
  const problems = [];
  for (const name of names) {
    const revision = await cloud(["run", "revisions", "describe", name]);
    const why = [];
    const annotations = revision.metadata?.annotations ?? {};
    let interfaces = [];
    try { interfaces = JSON.parse(annotations["run.googleapis.com/network-interfaces"] ?? "[]"); } catch { interfaces = []; }
    const nic = interfaces[0];
    if (!nic || nic.network !== network.network || nic.subnetwork !== network.subnet ||
        !network.tags.every(t => (nic.tags ?? []).includes(t))) why.push("network");
    if (annotations["run.googleapis.com/vpc-access-egress"] !== "all-traffic") why.push("egress");
    const container = revision.spec?.containers?.[0];
    const env = Object.fromEntries((container?.env ?? []).filter(e => typeof e?.value === "string").map(e => [e.name, e.value]));
    for (const [k, v] of Object.entries(want)) if (env[k] !== v) why.push(k);
    const volume = (revision.spec?.volumes ?? []).find(v => v.secret?.secretName === secretName &&
      (v.secret.items ?? []).some(i => i.path === caFile && i.key === secretVersion));
    const mounted = volume && (container?.volumeMounts ?? []).some(m => m.name === volume.name && m.mountPath === caDir);
    if (!mounted) why.push("ca");
    if (why.length) problems.push({ revision: name, problems: why });
  }
  return problems;
}
const describeNetwork = problems => problems.map(p => `${p.revision} (${p.problems.join(", ")})`).join(", ");

// The revisions among `names` that carry a variable in `forbiddenEnv`, set
// to anything (a value or a secret reference) in any container, or whose
// environment can't be read. Read from each revision itself: an older
// revision keeps the variables it was made with, whatever its commit, so this
// applies to every reachable revision, not only those past a milestone.
export async function forbiddenEnvProblems(context, names, { cloud }) {
  const forbidden = context.config.forbiddenEnv ?? [];
  if (!forbidden.length) return [];
  const problems = [];
  for (const name of names) {
    const revision = await cloud(["run", "revisions", "describe", name]);
    const containers = revision.spec?.containers;
    if (!Array.isArray(containers) || containers.length === 0) {
      problems.push({ revision: name, problem: "unreadable" });
      continue;
    }
    const carried = forbidden.filter(v => containers.some(c => (c.env ?? []).some(e => e?.name === v)));
    if (carried.length) problems.push({ revision: name, problem: "forbidden", env: carried });
  }
  return problems;
}
const describeForbidden = problems => problems.map(p =>
  `${p.revision} ${p.problem === "unreadable" ? "has no readable environment" : `carries forbidden ${p.env.join(", ")}`}`).join("; ");

// Every revision a service's traffic can reach: serving, or kept by a tag.
export const reachableRevisions = service => [...new Set((service.status?.traffic || []).map(t => t.revisionName).filter(Boolean))];

// Cross-service requirements (`requires`, resolved by loadConfig into
// context.requires): each reachable revision of each required service, serving
// or tagged, must meet the named milestone by the same provenance test as
// `baselines`. Returns the unmet ones, with the revisions below them.
export async function requirementProblems(context, { cloud, git }) {
  const problems = [];
  for (const r of context.requires ?? []) {
    const service = await cloud(["run", "services", "describe", r.cloudService]);
    const below = [];
    for (const name of reachableRevisions(service)) {
      if (!(await meetsMilestone(git, await provenanceOf(cloud, name), r.commit))) below.push(name);
    }
    if (below.length) problems.push({ service: r.service, milestone: r.milestone, below });
  }
  return problems;
}
const describeRequirements = problems => problems.map(p =>
  `Requires ${p.service} at its ${p.milestone} milestone, but ${p.below.join(", ")} ${p.below.length === 1 ? "is" : "are"} reachable below it`).join("; ");

// The other direction (context.requiredBy): revisions of this service, among
// `names`, below a milestone another service requires of it.
export async function requiredByProblems(context, names, { cloud, git }) {
  const problems = [];
  for (const r of context.requiredBy ?? []) {
    const below = [];
    for (const name of names) {
      if (!(await meetsMilestone(git, await provenanceOf(cloud, name), r.commit))) below.push(name);
    }
    if (below.length) problems.push({ requiredBy: r.service, milestone: r.milestone, below });
  }
  return problems;
}
const describeRequiredBy = problems => problems.map(p =>
  `${p.below.join(", ")} ${p.below.length === 1 ? "is" : "are"} below the ${p.milestone} milestone, which ${p.requiredBy} requires`).join("; ");

// The contract minimum each revision actually runs with (capability plan W4,
// RELEASE-01): `contractMinimum: { env, floor? }` names the variable Policy
// or Broker reads (POLICY_/BROKER_MIN_CONTRACT_VERSION) and, from the
// cutover, the floor. Read from each revision's own environment, since a
// configuration release of the same commit meets every baseline. Returns the
// revisions that fail, with why:
//   unreadable   no container environment, or the value comes from a secret
//   invalid      not 1 or 2 (the service would refuse to start)
//   missing      unset (the service's default, 1) while a floor applies
//   below-floor  set lower than the floor
export async function contractMinimumProblems(context, names, { cloud }) {
  const minimum = context.config.contractMinimum;
  if (!minimum) return [];
  const problems = [];
  for (const name of names) {
    const revision = await cloud(["run", "revisions", "describe", name]);
    const containers = revision.spec?.containers;
    if (!Array.isArray(containers) || containers.length === 0) {
      problems.push({ revision: name, problem: "unreadable" });
      continue;
    }
    const entry = (containers[0].env ?? []).find(e => e?.name === minimum.env);
    if (entry && (entry.valueFrom || typeof entry.value !== "string")) {
      problems.push({ revision: name, problem: "unreadable" });
      continue;
    }
    const value = entry?.value ?? "";
    if (value !== "" && value !== "1" && value !== "2") problems.push({ revision: name, value, problem: "invalid" });
    else if (minimum.floor && value === "") problems.push({ revision: name, problem: "missing" });
    else if (minimum.floor && Number(value) < minimum.floor) problems.push({ revision: name, value, problem: "below-floor" });
  }
  return problems;
}
const describeMinimum = (context, problems) => problems.map(p =>
  `${p.revision} (${context.config.contractMinimum.env} ${p.problem === "missing" ? "unset" : p.problem === "unreadable" ? "unreadable" : `=${p.value}`}${p.problem === "below-floor" ? `, below the floor ${context.config.contractMinimum.floor}` : ""})`).join(", ");

// What must hold before protected execution is switched back on: no tag still
// reaches a non-serving revision (when the service retires tags), and nothing
// serving is below the current milestone. Read-only.
// For a pinnable service, every REACHABLE revision counts, serving or kept by
// its tag (capability plan W4): each must be approved, not mid-retirement,
// support the required contract version, and meet the milestone.
export async function releaseCheck(context, { cloud, git, revisions = undefined }) {
  const { config } = context;
  const service = await cloud(["run", "services", "describe", config.service]);
  const serving = Object.keys(traffic(service));
  const baselines = config.baselines ?? [];
  let pinned = null;
  let keep = [];
  if (config.pinnable) {
    requireValue(revisions, "A pinnable service needs the revisions store");
    const records = await revisions.list();
    pinned = reachableProblems(service, records, { minContractVersion: config.pinnable.minContractVersion ?? 1 });
    keep = retainedTags(service, records);
  }
  const result = {
    service: config.service,
    serving,
    staleTags: config.retireTags ? staleTags(service, keep) : [],
    baseline: baselines.length ? baselines[baselines.length - 1] : null,
    belowBaseline: await belowBaseline(context, pinned ? pinned.reachable : serving, { cloud, git }),
    ...(pinned ? { revisions: pinned } : {}),
    // Every reachable revision, retained tags included.
    ...(config.contractMinimum ? { contractMinimum: await contractMinimumProblems(context, reachableRevisions(service), { cloud }) } : {}),
    // ISOLATE-01: every reachable revision, retained tags included, runs on the network.
    ...(config.network ? { network: await networkProblems(context, reachableRevisions(service), { cloud }) } : {}),
    // Every reachable revision, retained tags included, is free of forbiddenEnv.
    ...(config.forbiddenEnv ? { forbiddenEnv: await forbiddenEnvProblems(context, reachableRevisions(service), { cloud }) } : {}),
    // Each required service's reachable revisions meet the milestone this one needs.
    ...(context.requires?.length ? { requires: await requirementProblems(context, { cloud, git }) } : {}),
  };
  const pinnedOk = !pinned || ["unapproved", "retiring", "retired", "unsupportedContract"].every(k => pinned[k].length === 0);
  const minimumOk = (result.contractMinimum ?? []).length === 0;
  const networkOk = (result.network ?? []).length === 0;
  const forbiddenOk = (result.forbiddenEnv ?? []).length === 0;
  const requiresOk = (result.requires ?? []).length === 0;
  return { ...result, ok: result.staleTags.length === 0 && result.belowBaseline.length === 0 && pinnedOk && minimumOk && networkOk && forbiddenOk && requiresOk };
}

// Approves an already-released revision of a pinnable service from its
// receipt: for a revision released before the service was pinnable.
export async function approveReleased(context, receipt, { cloud, revisions }) {
  const { config } = context;
  requireValue(config.pinnable, `${config.service} is not pinnable`);
  requireValue(receipt.service === config.service && receipt.status === "released", `Release ${receipt.id} is not a released ${config.service} revision`);
  const service = await cloud(["run", "services", "describe", config.service]);
  const record = await revisions.approve(approvalRecord(config, receipt, service));
  return { ...receipt, approval: { ...record, approvedAt: record.approvedAt.toISOString() } };
}

// Rolling back below the current milestone is refused unless
// `allowBelowBaseline`, and even then only after `switchState` (Policy's and
// Broker's own /v1/protected-execution) confirms protected execution is off in
// both. A service that enforces the switch itself is never rolled back below
// its first milestone: older code ignores the switch, so there would be no way
// to keep protected execution off.
/** @param {{ cloud: any, log: any, git?: any, switchState?: () => Promise<{ policy: boolean, broker: boolean }>, allowBelowBaseline?: boolean }} deps */
export async function rollback(context, receipt, deps) {
  const { cloud, log, git, switchState, allowBelowBaseline = false } = deps;
  const { config, environment } = context;
  requireValue(receipt.version === 1 && receipt.project === config.project && receipt.region === config.region && receipt.service === config.service && receipt.environment === environment, "Release receipt does not match the deployment target");
  requireValue(receipt.revision && receipt.previousTraffic, "Receipt has no rollback target");
  const sum = Object.values(receipt.previousTraffic).reduce((a, b) => a + b, 0);
  requireValue(sum === 100 && Object.entries(receipt.previousTraffic).every(([k, v]) => /^[a-z][a-z0-9-]+$/.test(k) && Number.isInteger(v) && v > 0), "Invalid rollback traffic in receipt");
  const current = await cloud(["run", "services", "describe", config.service]);
  requireValue(same(traffic(current), { [receipt.revision]: 100 }), "Traffic no longer belongs exclusively to this release; refusing to overwrite a newer deployment");
  const targets = Object.keys(receipt.previousTraffic);
  // ISOLATE-01: never put traffic back on a revision without the network's
  // controls. No override: roll forward, or back to a controlled revision.
  const uncontrolled = await networkProblems(context, targets, { cloud });
  requireValue(uncontrolled.length === 0,
    `Rollback target ${describeNetwork(uncontrolled)} doesn't run with this service's network controls (ISOLATE-01); refusing, with no override. Roll forward, or roll back to a revision that has them.`);
  // Nor on one carrying a forbidden variable: a revision of the current commit
  // can still carry one from its release's configuration. No override.
  const forbidden = await forbiddenEnvProblems(context, targets, { cloud });
  requireValue(forbidden.length === 0,
    `Rollback target ${describeForbidden(forbidden)} (forbiddenEnv); refusing, with no override. Roll forward, or roll back to a revision without it.`);
  // Nor below a milestone another service requires of this one: that service
  // would fail closed. No override, --below-baseline included.
  const required = await requiredByProblems(context, targets, { cloud, git });
  requireValue(required.length === 0,
    `Rollback target ${describeRequiredBy(required)}; refusing, with no override. Roll forward; the requirement stays until ${[...new Set(required.map(p => p.requiredBy))].join(", ")}'s requires entry is removed from deploy.json, once no reachable revision of it needs the milestone.`);
  const below = await belowBaseline(context, targets, { cloud, git });
  // A configuration rollback from the same commit meets every baseline, but
  // can lower the contract minimum: guarded the same way.
  const belowFloor = await contractMinimumProblems(context, targets, { cloud });
  if (belowFloor.length) {
    requireValue(allowBelowBaseline,
      `Rollback target ${describeMinimum(context, belowFloor)} doesn't keep the contract minimum. ` +
      "Pass --below-baseline only with protected execution switched off; it cannot be switched back on until every reachable revision keeps it again.");
  }
  if (below.length) {
    const baselines = config.baselines;
    const milestone = baselines[baselines.length - 1].milestone;
    requireValue(allowBelowBaseline,
      `Rollback target ${below.join(", ")} is below the ${milestone} milestone. ` +
      "Pass --below-baseline only with protected execution switched off; it cannot be switched back on until the service meets the milestone again.");
    if (config.enforcesSwitch) {
      const beforeSwitch = await belowBaseline(context, targets, { cloud, git }, "first");
      requireValue(beforeSwitch.length === 0,
        `Rollback target ${beforeSwitch.join(", ")} predates the ${baselines[0].milestone} milestone, whose code honours the protected-execution switch; refusing, since nothing could keep protected execution off. Roll forward instead.`);
    }
  }
  if (below.length || belowFloor.length) {
    requireValue(typeof switchState === "function", "Cannot verify that protected execution is off");
    const state = await switchState();
    requireValue(state.policy === false && state.broker === false,
      `Protected execution must be off before rolling back below a milestone or the contract minimum (policy ${state.policy ? "on" : "off"}, broker ${state.broker ? "on" : "off"})`);
  }
  log(`Restoring traffic to ${pairs(receipt.previousTraffic)}…`);
  await cloud(["run", "services", "update-traffic", config.service, `--to-revisions=${pairs(receipt.previousTraffic)}`]);
  const final = await cloud(["run", "services", "describe", config.service]);
  requireValue(same(traffic(final), receipt.previousTraffic), "Rollback traffic could not be verified");
  return {
    ...receipt,
    status: "rolled-back",
    rolledBackAt: new Date().toISOString(),
    ...(below.length ? { rolledBackBelowBaseline: below } : {}),
    ...(belowFloor.length ? { rolledBackBelowContractMinimum: belowFloor } : {}),
  };
}

export async function readReceipt(root, id) {
  return JSON.parse(await readFile(path.join(root, ".gc-deploy", "releases", `${id}.json`), "utf8"));
}
