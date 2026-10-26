import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// ISOLATE-01 (W5 stage 4): a compiler's egress. Every revision runs on the
// compiler network with all traffic through its VPC, reaches the outside only
// through the egress proxy (HTTPS_PROXY/HTTP_PROXY; NO_PROXY is the metadata
// server only), and trusts the private CA whose certificates the proxy
// presents for the hosts it terminates TLS for. `allow` is the reviewed host
// list the proxy enforces, kept here so it's reviewed with the service; the
// CLI records it, and deploy/egress-proxy generates the proxy's config from it.
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const validNetwork = n => object(n) &&
  typeof n.network === "string" && /^[a-z][a-z0-9-]{0,62}$/.test(n.network) &&
  typeof n.subnet === "string" && /^[a-z][a-z0-9-]{0,62}$/.test(n.subnet) &&
  Array.isArray(n.tags) && n.tags.length > 0 && n.tags.every(t => typeof t === "string" && /^[a-z][a-z0-9-]{0,62}$/.test(t)) &&
  typeof n.proxy === "string" && /^https?:\/\/[A-Za-z0-9.-]+:\d{2,5}$/.test(n.proxy) &&
  object(n.ca) && typeof n.ca.secret === "string" && /^[A-Za-z0-9_-]+:(\d+|latest)$/.test(n.ca.secret) && n.ca.secret.split(":")[1] !== "latest" &&
  typeof n.ca.path === "string" && /^\/[A-Za-z0-9._/-]+\/[A-Za-z0-9._-]+$/.test(n.ca.path) &&
  Array.isArray(n.allow) && n.allow.every(h => typeof h === "string" && HOSTNAME.test(h));

export const hash = value => createHash("sha256").update(value).digest("hex");
export const requireValue = (value, message) => {
  if (!value) throw new Error(message);
  return value;
};
const object = value => value && typeof value === "object" && !Array.isArray(value);
const namePattern = /^[a-z][a-z0-9-]{0,39}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Every setting the CLI reads. Anything else is refused rather than ignored,
// so a misspelt or unsupported setting (`maxInstance`, `minInstances` before
// it was supported) can't be silently dropped from a release.
export const SETTINGS = Object.freeze([
  "service", "project", "region", "image", "dockerfile", "port", "access", "runtimeServiceAccount", "buildServiceAccount",
  "smokeServiceAccount", "steps", "smoke", "verify", "env", "secrets", "removeSecrets", "removeEnv", "forbiddenEnv",
  "minInstances", "maxInstances", "concurrency", "retireTags", "pinnable", "baselines", "enforcesSwitch", "contractMinimum", "network",
  "protectedExecution", "requires", "exclude", "include", "blocked",
]);

export function parseArgs(args) {
  const options = { command: "deploy", env: "production", config: "deploy.json" };
  if (["deploy", "rollback", "retire-tags", "release-check", "approve", "promote", "reconcile-image-tags"].includes(args[0])) options.command = args.shift();
  while (args.length) {
    const arg = args.shift();
    if (["--plan", "--allow-dirty", "--help", "--below-baseline", "--json", "--stage"].includes(arg)) options[arg.slice(2)] = true;
    else if (["--env", "--config", "--release", "--evidence"].includes(arg)) {
      const value = args.shift();
      requireValue(value && !value.startsWith("--"), `${arg} requires a value`);
      options[arg.slice(2)] = value;
    } else if (!arg.startsWith("-") && !options.service) options.service = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (["rollback", "approve", "promote"].includes(options.command) && !options.help) {
    requireValue(options.release && /^[a-z0-9-]+$/.test(options.release), `${options.command} requires --release <release-id>`);
  }
  if (options.command === "promote" && !options.help) requireValue(options.evidence, "promote requires --evidence <file>");
  requireValue(!options.stage || options.command === "deploy", "--stage applies only to a release (deploy)");
  requireValue(!options.evidence || options.command === "promote", "--evidence applies only to promote");
  requireValue(!(options.command === "reconcile-image-tags" && options.service), "reconcile-image-tags covers the whole project; it takes no service");
  return options;
}

// An environment's project and region, for commands that cover a whole project
// rather than one service (reconcile-image-tags).
export async function loadEnvironment(options, cwd = process.cwd()) {
  const filename = path.resolve(cwd, options.config);
  const raw = JSON.parse(await readFile(filename, "utf8"));
  requireValue(raw.version === 1 && object(raw.services), "Expected deploy.json version 1 with services");
  const environment = raw.environments?.[options.env];
  requireValue(object(environment) && typeof environment.project === "string" && typeof environment.region === "string",
    `Environment ${options.env} needs a project and region`);
  return { root: path.dirname(filename), project: environment.project, region: environment.region };
}

export async function loadConfig(options, cwd = process.cwd(), env = process.env) {
  const filename = path.resolve(cwd, options.config);
  const raw = JSON.parse(await readFile(filename, "utf8"));
  requireValue(raw.version === 1 && object(raw.services), "Expected deploy.json version 1 with services");
  const service = options.service || (Object.keys(raw.services).length === 1 ? Object.keys(raw.services)[0] : null);
  requireValue(service && raw.services[service], `Choose a service: ${Object.keys(raw.services).join(", ")}`);
  requireValue(object(raw.environments?.[options.env]), `Unknown environment: ${options.env}`);
  const unresolved = [];
  const expander = sink => {
    const expand = value => {
      if (typeof value === "string") {
        return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, key) => {
          if (!env[key]) sink.push(key);
          return env[key] || match;
        });
      }
      if (Array.isArray(value)) return value.map(expand);
      if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
      return value;
    };
    return expand;
  };
  // Environment-wide settings, service settings, then per-environment service
  // overrides. Other services' settings (for `requires`) resolve the same way,
  // without adding to this release's required variables.
  const resolve = (name, sink = []) => {
    const { environments, ...definition } = raw.services[name];
    const resolved = expander(sink)({ ...raw.environments[options.env], ...definition, ...environments?.[options.env] });
    resolved.service = resolved.service || name;
    return resolved;
  };
  const config = resolve(service, unresolved);
  const unknown = Object.keys(config).filter(key => !SETTINGS.includes(key));
  requireValue(unknown.length === 0, `Unknown setting(s) for ${service}: ${unknown.join(", ")}`);
  for (const key of ["service", "project", "region"]) requireValue(namePattern.test(config[key]), `Invalid ${key}`);
  requireValue(typeof config.image === "string" && /^[a-z0-9.-]+\/(?:[a-z0-9_-]+\/)+[a-z0-9_-]+$/.test(config.image), "image must be an untagged registry image path");
  requireValue(["public", "private"].includes(config.access), "access must be public or private");
  requireValue(Number.isInteger(config.port) && config.port > 0 && config.port <= 65535, "Invalid port");
  requireValue(typeof config.dockerfile === "string" && !path.isAbsolute(config.dockerfile) && !config.dockerfile.split(/[\\/]/).includes(".."), "dockerfile must be relative to the workspace");
  requireValue(Array.isArray(config.steps) && config.steps.length, "steps must contain build/test steps");
  for (const step of config.steps) requireValue(typeof step.name === "string" && Array.isArray(step.args), "Each build step requires name and args");
  requireValue(Array.isArray(config.smoke) && config.smoke.length, "At least one smoke check is required");
  for (const check of config.smoke) {
    requireValue(typeof check.path === "string" && check.path.startsWith("/") && !check.path.startsWith("//") && !check.path.includes("\\"), "Smoke paths must be local URL paths");
    requireValue(Number.isInteger(check.status) && check.status >= 200 && check.status < 300, "Smoke checks must expect a successful HTTP status");
    requireValue(check.timeoutMs === undefined || (Number.isInteger(check.timeoutMs) && check.timeoutMs >= 1000 && check.timeoutMs <= 600000), "Smoke timeoutMs must be an integer from 1000 to 600000");
  }
  requireValue(!config.verify || (object(config.verify) && typeof config.verify.module === "string" && /\.m?js$/.test(config.verify.module) && !path.isAbsolute(config.verify.module) && !config.verify.module.split(/[\\/]/).includes("..")), "verify.module must be a relative .js path in the workspace");
  requireValue(typeof config.runtimeServiceAccount === "string", "runtimeServiceAccount is required");
  requireValue(typeof config.buildServiceAccount === "string", "buildServiceAccount is required");
  requireValue(!config.env || object(config.env), "env must be an object");
  requireValue(!config.secrets || object(config.secrets), "secrets must be an object");
  requireValue(config.retireTags === undefined || typeof config.retireTags === "boolean", "retireTags must be a boolean");
  requireValue(config.pinnable === undefined || (object(config.pinnable) && /^\d{4}$/.test(config.pinnable.lang ?? "") &&
    (config.pinnable.contractVersions === undefined || (Array.isArray(config.pinnable.contractVersions) && config.pinnable.contractVersions.length > 0 && config.pinnable.contractVersions.every(v => Number.isInteger(v) && v > 0))) &&
    (config.pinnable.minContractVersion === undefined || (Number.isInteger(config.pinnable.minContractVersion) && config.pinnable.minContractVersion > 0)) &&
    (config.pinnable.database === undefined || /^[a-z][a-z0-9-]{0,62}$/.test(config.pinnable.database))),
  "pinnable must be { lang: \"NNNN\", contractVersions?: [int], minContractVersion?: int, database?: name }");
  requireValue(config.baselines === undefined || (Array.isArray(config.baselines) && config.baselines.length > 0 &&
    config.baselines.every(b => object(b) && typeof b.milestone === "string" && b.milestone.length > 0 && typeof b.commit === "string" && /^[0-9a-f]{40}$/.test(b.commit)) &&
    new Set(config.baselines.map(b => b.milestone)).size === config.baselines.length), "baselines must be a non-empty list of { milestone, commit: <40-hex commit> }, oldest first");
  requireValue(config.enforcesSwitch === undefined || typeof config.enforcesSwitch === "boolean", "enforcesSwitch must be a boolean");
  // The contract minimum (W4): the variable Policy or Broker reads, and from
  // the cutover its floor, which this file's own value must then keep (a
  // release can't lower it; release-check reads what revisions actually run).
  requireValue(config.contractMinimum === undefined || (object(config.contractMinimum) &&
    /^[A-Z][A-Z0-9_]*$/.test(config.contractMinimum.env ?? "") &&
    (config.contractMinimum.floor === undefined || config.contractMinimum.floor === 1 || config.contractMinimum.floor === 2)),
  "contractMinimum must be { env: NAME, floor?: 1 | 2 }");
  if (config.contractMinimum?.floor) {
    const value = config.env?.[config.contractMinimum.env];
    requireValue((value === "1" || value === "2") && Number(value) >= config.contractMinimum.floor,
      `${config.contractMinimum.env} must be set in env to at least the contract floor ${config.contractMinimum.floor}`);
  }
  requireValue(config.network === undefined || validNetwork(config.network),
    "network must be { network, subnet, tags: [..], proxy: \"http(s)://host:port\", ca: { secret: \"name:version\", path: \"/abs/file\" }, allow: [hostnames] }");
  if (config.network) {
    // The CLI sets these from `network`; a service may not set its own.
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "https_proxy", "http_proxy", "no_proxy"]) {
      requireValue(!Object.prototype.hasOwnProperty.call(config.env || {}, name), `${name} comes from network; remove it from env`);
    }
  }
  requireValue(config.protectedExecution === undefined || (object(config.protectedExecution) &&
    ["policyUrl", "brokerUrl"].every(k => typeof config.protectedExecution[k] === "string" && /^https:\/\/[^/]+$/.test(config.protectedExecution[k]))), "protectedExecution must be { policyUrl, brokerUrl } service origins");
  requireValue(!config.removeSecrets || (Array.isArray(config.removeSecrets) && config.removeSecrets.length > 0 &&
    config.removeSecrets.every(n => typeof n === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))), "removeSecrets must be a non-empty array of environment names");
  for (const name of config.removeSecrets || []) {
    requireValue(!Object.prototype.hasOwnProperty.call(config.secrets || {}, name), `Secret ${name} cannot be both mounted and removed`);
  }
  // Variables each release removes from the service (--remove-env-vars):
  // --update-env-vars keeps every variable it isn't given, so dropping a name
  // from `env` leaves it set. The CLI's own variables can't be removed.
  const envNames = (list, key) => requireValue(list === undefined || (Array.isArray(list) && list.length > 0 &&
    list.every(n => typeof n === "string" && ENV_NAME.test(n)) && new Set(list).size === list.length),
  `${key} must be a non-empty array of distinct environment variable names`);
  envNames(config.removeEnv, "removeEnv");
  envNames(config.forbiddenEnv, "forbiddenEnv");
  const managed = ["GC_RELEASE", "GC_IMAGE_DIGEST", ...(config.network ? ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY"] : [])];
  for (const name of config.removeEnv || []) {
    requireValue(!Object.prototype.hasOwnProperty.call(config.env || {}, name), `${name} cannot be both set in env and listed in removeEnv`);
    requireValue(!managed.includes(name), `${name} is set by the deploy CLI; it can't be in removeEnv`);
    requireValue(!Object.prototype.hasOwnProperty.call(config.secrets || {}, name), `${name} is a secret mount; remove it with removeSecrets, not removeEnv`);
  }
  // Variables no reachable revision may carry (release-check, rollback, and
  // each release's candidate before promotion).
  for (const name of config.forbiddenEnv || []) {
    requireValue(!Object.prototype.hasOwnProperty.call(config.env || {}, name), `${name} is in forbiddenEnv; it can't be set in env`);
    requireValue(!Object.prototype.hasOwnProperty.call(config.secrets || {}, name), `${name} is in forbiddenEnv; it can't be mounted in secrets`);
    requireValue(!managed.includes(name), `${name} is set by the deploy CLI; it can't be in forbiddenEnv`);
  }
  // Revision scaling (--min-instances / --max-instances). Like every template
  // setting, a value persists on later releases until changed, so deleting the
  // field doesn't clear it.
  requireValue(config.minInstances === undefined || (Number.isInteger(config.minInstances) && config.minInstances >= 0 && config.minInstances <= 1000), "minInstances must be an integer from 0 to 1000");
  requireValue(config.maxInstances === undefined || (Number.isInteger(config.maxInstances) && config.maxInstances >= 1 && config.maxInstances <= 1000), "maxInstances must be an integer from 1 to 1000");
  requireValue(config.minInstances === undefined || config.maxInstances === undefined || config.minInstances <= config.maxInstances, "minInstances cannot exceed maxInstances");
  requireValue(config.concurrency === undefined || (Number.isInteger(config.concurrency) && config.concurrency >= 1 && config.concurrency <= 1000), "concurrency must be an integer from 1 to 1000");
  requireValue(!config.exclude || (Array.isArray(config.exclude) && config.exclude.every(p => typeof p === "string" && p.length > 0)), "exclude must be an array of relative paths");
  requireValue(!config.include || (Array.isArray(config.include) && config.include.length > 0 && config.include.every(p => typeof p === "string" && p.length > 0 && !path.isAbsolute(p) && !p.split(/[\\/]/).includes(".."))), "include must be a non-empty array of relative paths");
  for (const key of ["runtimeServiceAccount", "buildServiceAccount", ...(config.access === "private" ? ["smokeServiceAccount"] : [])]) {
    requireValue(typeof config[key] === "string" && (/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(config[key]) || /^\$\{[A-Z0-9_]+\}$/.test(config[key])), `Invalid ${key}`);
  }
  requireValue(config.runtimeServiceAccount !== config.buildServiceAccount, "Build and runtime service accounts must be separate");
  for (const [key, value] of Object.entries(config.secrets || {})) {
    requireValue(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key), `Invalid secret environment name ${key}`);
    requireValue(typeof value === "string" && /^[A-Za-z0-9_-]+:(?:[1-9][0-9]*|\$\{[A-Z0-9_]+\})$/.test(value), `Secret ${key} must reference a numbered version`);
  }
  for (const [key, value] of Object.entries(config.env || {})) {
    requireValue(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === "string", `Invalid environment variable ${key}`);
  }
  // Cross-service requirements: `requires` names milestones of other services
  // that every reachable revision of each must meet while this service serves
  // (broker refuses system-session tokens without Policy's `sexp` claim).
  // `requires` is resolved for this service's releases and release-check;
  // `requiredBy` lists the services requiring one of this service's
  // milestones, which its own releases and rollbacks must not go below.
  const requirement = (from, entry) => {
    requireValue(object(entry) && Object.keys(entry).every(k => ["service", "milestone"].includes(k)) &&
      typeof entry.service === "string" && typeof entry.milestone === "string",
    `${from}: requires must be a non-empty list of { service, milestone }`);
    requireValue(entry.service !== from, `${from} cannot require itself`);
    requireValue(object(raw.services[entry.service]), `${from} requires ${entry.service}, which is not a service in deploy.json`);
    const target = resolve(entry.service);
    const baseline = (Array.isArray(target.baselines) ? target.baselines : []).find(b => b?.milestone === entry.milestone);
    requireValue(baseline && /^[0-9a-f]{40}$/.test(baseline.commit ?? ""), `${from} requires the ${entry.milestone} milestone of ${entry.service}, which is not in its baselines`);
    return { service: entry.service, cloudService: target.service, project: target.project, region: target.region, milestone: entry.milestone, commit: baseline.commit };
  };
  const requirementsOf = (from, settings) => {
    if (settings.requires === undefined) return [];
    requireValue(Array.isArray(settings.requires) && settings.requires.length > 0, `${from}: requires must be a non-empty list of { service, milestone }`);
    const list = settings.requires.map(entry => requirement(from, entry));
    requireValue(new Set(list.map(r => `${r.service}/${r.milestone}`)).size === list.length, `${from}: requires lists a milestone twice`);
    return list;
  };
  const requires = requirementsOf(service, config);
  for (const r of requires) {
    // Releases and release-check read the required service with this service's gcloud scope.
    requireValue(r.project === config.project && r.region === config.region, `${service} requires ${r.service}, which is in another project or region`);
  }
  const requiredBy = [];
  for (const other of Object.keys(raw.services)) {
    if (other === service) continue;
    for (const r of requirementsOf(other, resolve(other))) {
      if (r.service === service) requiredBy.push({ service: other, milestone: r.milestone, commit: r.commit });
    }
  }
  return { root: path.dirname(filename), config, service, environment: options.env, unresolved: [...new Set(unresolved)], configHash: hash(JSON.stringify(config)), requires, requiredBy };
}
