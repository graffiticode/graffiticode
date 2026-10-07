import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const hash = value => createHash("sha256").update(value).digest("hex");
export const requireValue = (value, message) => {
  if (!value) throw new Error(message);
  return value;
};
const object = value => value && typeof value === "object" && !Array.isArray(value);
const namePattern = /^[a-z][a-z0-9-]{0,39}$/;

export function parseArgs(args) {
  const options = { command: "deploy", env: "production", config: "deploy.json" };
  if (["deploy", "rollback", "retire-tags", "release-check", "approve"].includes(args[0])) options.command = args.shift();
  while (args.length) {
    const arg = args.shift();
    if (["--plan", "--allow-dirty", "--help", "--below-baseline", "--json"].includes(arg)) options[arg.slice(2)] = true;
    else if (["--env", "--config", "--release"].includes(arg)) {
      const value = args.shift();
      requireValue(value && !value.startsWith("--"), `${arg} requires a value`);
      options[arg.slice(2)] = value;
    } else if (!arg.startsWith("-") && !options.service) options.service = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (["rollback", "approve"].includes(options.command) && !options.help) {
    requireValue(options.release && /^[a-z0-9-]+$/.test(options.release), `${options.command} requires --release <release-id>`);
  }
  return options;
}

export async function loadConfig(options, cwd = process.cwd(), env = process.env) {
  const filename = path.resolve(cwd, options.config);
  const raw = JSON.parse(await readFile(filename, "utf8"));
  requireValue(raw.version === 1 && object(raw.services), "Expected deploy.json version 1 with services");
  const service = options.service || (Object.keys(raw.services).length === 1 ? Object.keys(raw.services)[0] : null);
  requireValue(service && raw.services[service], `Choose a service: ${Object.keys(raw.services).join(", ")}`);
  requireValue(object(raw.environments?.[options.env]), `Unknown environment: ${options.env}`);
  const unresolved = [];
  const expand = value => {
    if (typeof value === "string") {
      return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, key) => {
        if (!env[key]) unresolved.push(key);
        return env[key] || match;
      });
    }
    if (Array.isArray(value)) return value.map(expand);
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
    return value;
  };
  // Environment-wide settings, service settings, then per-environment service overrides.
  const { environments, ...definition } = raw.services[service];
  const config = expand({ ...raw.environments[options.env], ...definition, ...environments?.[options.env] });
  config.service = config.service || service;
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
  requireValue(config.protectedExecution === undefined || (object(config.protectedExecution) &&
    ["policyUrl", "brokerUrl"].every(k => typeof config.protectedExecution[k] === "string" && /^https:\/\/[^/]+$/.test(config.protectedExecution[k]))), "protectedExecution must be { policyUrl, brokerUrl } service origins");
  requireValue(!config.removeSecrets || (Array.isArray(config.removeSecrets) && config.removeSecrets.length > 0 &&
    config.removeSecrets.every(n => typeof n === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))), "removeSecrets must be a non-empty array of environment names");
  for (const name of config.removeSecrets || []) {
    requireValue(!Object.prototype.hasOwnProperty.call(config.secrets || {}, name), `Secret ${name} cannot be both mounted and removed`);
  }
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
  return { root: path.dirname(filename), config, service, environment: options.env, unresolved: [...new Set(unresolved)], configHash: hash(JSON.stringify(config)) };
}
