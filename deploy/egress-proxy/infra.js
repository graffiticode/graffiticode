#!/usr/bin/env node
// ISOLATE-01: the infrastructure for the egress proxy, as the gcloud commands
// that create it. Plan: ~/.claude/plans/isolate-01-compiler-egress.md
// ("The proxy", rollout steps 0 and 1). Runbook: README.md.
//
//   node deploy/egress-proxy/infra.js --plan [--deploy deploy.json] [--classes classes.json]
//   node deploy/egress-proxy/infra.js --apply --steps 1,2 --classes step0/classes.json --deploy step0/deploy.json [--workdir dir]
//
// Production deployment is deferred (Jeff, 2026-10-14): for production this
// prints the commands for review and never runs them. --apply runs them only
// against a scratch project (SCRATCH_PROJECTS), for rollout step 0: every
// command must name that project, no placeholder may remain, and nothing is
// ever run against graffiticode.

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { load, terminatedHosts, slug, BLOCKED, compilerAccounts, alertPolicies, envoyConfig, cloudInit, sha256 } from "./generate.js";

export const DEFERRED = "deployment deferred (ISOLATE-01): infra.js only prints its commands; run with --plan";

// The only projects --apply will touch: rollout step 0's prototype.
export const SCRATCH_PROJECTS = new Set(["graffiticode-isolate01"]);

const q = s => (/^[A-Za-z0-9_./:=@,+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);
// A command prints as a quoted shell line and keeps its argv, so --apply runs
// exactly what --plan shows, without a shell.
class Cmd extends String {
  constructor(argv) {
    super(argv.map(q).join(" "));
    this.argv = argv;
  }
}
const cmd = (...args) => new Cmd(args.flat().filter(a => a !== null && a !== undefined && a !== false).map(String));

export function commands(model) {
  const { project, region, network } = model;
  const p = `--project=${project}`;
  const r = `--region=${region}`;
  const sa = model.proxy.serviceAccount;
  const classes = Object.values(model.classes);
  const hosts = terminatedHosts(model);
  const lb = model.loadBalancerAddress;
  const zones = model.proxy.zones ?? [];
  if (zones.length !== 2 || zones.some(z => !z.startsWith(`${region}-`))) {
    throw new Error(`classes.json: proxy.zones must pin two zones in ${region}`);
  }
  const accounts = compilerAccounts(model);
  // The template is named by everything it carries, its whole user-data (Envoy's
  // config and the host units): any change is a new template and a rolling replace,
  // and the same user-data is the same name. Found in step 0: named by the Envoy
  // config alone, a host-unit change kept the old name, was skipped as existing,
  // and rolled out nothing. Unpinned images leave a placeholder, which --apply refuses.
  const envoy = envoyConfig(model);
  let templateVersion;
  try { templateVersion = sha256(cloudInit(model, envoy)).slice(0, 12); } catch { templateVersion = "<user-data digest: pin the images>"; }
  const steps = [];
  const step = (title, ...lines) => steps.push({ title, lines });

  step("Compiler VPC and subnets (IPv4 only)",
    cmd("gcloud", "compute", "networks", "create", network, p, "--subnet-mode=custom"),
    cmd("gcloud", "compute", "networks", "subnets", "create", model.proxySubnet.name, p, r, `--network=${network}`, `--range=${model.proxySubnet.cidr}`, "--stack-type=IPV4_ONLY"),
    ...classes.map(c => cmd("gcloud", "compute", "networks", "subnets", "create", c.name, p, r, `--network=${network}`, `--range=${c.cidr}`, "--stack-type=IPV4_ONLY")),
    // Reserved before any proxy VM exists: unreserved, a VM in the proxy subnet
    // could be given the load balancer's address, and the forwarding rule would
    // then fail. A reservation takes it out of automatic allocation.
    cmd("gcloud", "compute", "addresses", "create", "egress-proxy-lb", p, r, `--subnet=${model.proxySubnet.name}`, `--addresses=${lb}`, "--purpose=GCE_ENDPOINT",
      "--description=ISOLATE-01: the egress proxy's internal load balancer"));

  // Matched by the compiler subnets' source ranges, never by a network tag a
  // deployment could leave out (A6). Classic VPC egress rules can only target
  // tags or service accounts, so this is a network firewall policy, whose
  // egress rules take --src-ip-ranges and are evaluated before the VPC rules
  // (the proxy VMs' own rules below never match a compiler source).
  const compilerRanges = `--src-ip-ranges=${classes.map(c => c.cidr).join(",")}`;
  const fp = ["--firewall-policy=compilers-egress", "--global-firewall-policy", p];
  step("Firewall: compilers reach only the load balancer (a network firewall policy, matched by the compiler subnets' source ranges)",
    cmd("gcloud", "compute", "network-firewall-policies", "create", "compilers-egress", "--global", p, "--description=ISOLATE-01: compiler subnets reach only the egress proxy"),
    cmd("gcloud", "compute", "network-firewall-policies", "rules", "create", "100", ...fp, "--direction=EGRESS", "--action=allow",
      `--layer4-configs=tcp:${model.proxy.listenPort}`, compilerRanges, `--dest-ip-ranges=${lb}/32`, "--description=compilers to the proxy's load balancer"),
    cmd("gcloud", "compute", "network-firewall-policies", "rules", "create", "200", ...fp, "--direction=EGRESS", "--action=deny",
      "--layer4-configs=tcp:53,udp:53,tcp:853", compilerRanges, "--dest-ip-ranges=0.0.0.0/0", "--enable-logging", "--description=no DNS but the metadata server's"),
    cmd("gcloud", "compute", "network-firewall-policies", "rules", "create", "1000", ...fp, "--direction=EGRESS", "--action=deny",
      "--layer4-configs=all", compilerRanges, "--dest-ip-ranges=0.0.0.0/0", "--enable-logging", "--description=nothing else"),
    cmd("gcloud", "compute", "network-firewall-policies", "associations", "create", ...fp, `--network=${network}`, "--name=compilers-egress"),
    "# Rollout step 0 confirms Direct VPC egress traffic from Cloud Run matches these source ranges.");

  step("Firewall: the proxy VMs (stateful: replies to compilers and health checks are return traffic)",
    cmd("gcloud", "compute", "firewall-rules", "create", "egress-proxy-allow-compilers", p, `--network=${network}`, "--direction=INGRESS", "--action=ALLOW",
      `--rules=tcp:${model.proxy.listenPort}`, `--source-ranges=${classes.map(c => c.cidr).join(",")}`, `--target-service-accounts=${sa}`, "--priority=1000"),
    cmd("gcloud", "compute", "firewall-rules", "create", "egress-proxy-allow-health", p, `--network=${network}`, "--direction=INGRESS", "--action=ALLOW",
      `--rules=tcp:${model.proxy.healthPort}`, `--source-ranges=${model.proxy.healthCheckRanges.join(",")}`, `--target-service-accounts=${sa}`, "--priority=1000"),
    // The metadata ranges are listed for completeness, but Google's firewall
    // always allows a VM's own metadata server (169.254.169.254), so this rule
    // doesn't keep Envoy from it: the host's UID rules (ENVOY_OUT) do, and step 0
    // proves them on the VM.
    cmd("gcloud", "compute", "firewall-rules", "create", "egress-proxy-deny-internal", p, `--network=${network}`, "--direction=EGRESS", "--action=DENY", "--rules=all",
      `--destination-ranges=${[...BLOCKED, ...classes.map(c => c.cidr), `${lb}/32`].join(",")}`, `--target-service-accounts=${sa}`, "--priority=900", "--enable-logging"),
    cmd("gcloud", "compute", "firewall-rules", "create", "egress-proxy-allow-resolvers", p, `--network=${network}`, "--direction=EGRESS", "--action=ALLOW",
      "--rules=tcp:53,udp:53", `--destination-ranges=${model.proxy.resolvers.map(x => `${x}/32`).join(",")}`, `--target-service-accounts=${sa}`, "--priority=950"),
    cmd("gcloud", "compute", "firewall-rules", "create", "egress-proxy-allow-web", p, `--network=${network}`, "--direction=EGRESS", "--action=ALLOW",
      "--rules=tcp:80,tcp:443", "--destination-ranges=0.0.0.0/0", `--target-service-accounts=${sa}`, "--priority=1000"),
    cmd("gcloud", "compute", "firewall-rules", "create", "egress-proxy-deny-rest", p, `--network=${network}`, "--direction=EGRESS", "--action=DENY", "--rules=all",
      "--destination-ranges=0.0.0.0/0", `--target-service-accounts=${sa}`, "--priority=65000"));

  // Settled in step 0 (2026-10-18), form (a): a private zone for the root, bound to the
  // compiler network, holding only the metadata server's name. Lookups from Cloud Run's Direct
  // VPC egress got a genuine NXDOMAIN; their labels never reached the authoritative server,
  // whose log recorded the outside control sent afterwards; ID tokens still came from
  // metadata.google.internal. The proxy VMs resolve through their own fixed resolvers
  // (egress-resolver), so it doesn't touch them: they cold-booted healthy under it.
  // Response-policy rules can only answer or bypass, so they can't refuse.
  step("DNS: compilers resolve nothing but the metadata server",
    cmd("gcloud", "dns", "managed-zones", "create", "compilers-root", p, "--dns-name=.", "--visibility=private", `--networks=${network}`,
      "--description=ISOLATE-01: an empty root for the compiler VPC"),
    cmd("gcloud", "dns", "record-sets", "create", "metadata.google.internal.", p, "--zone=compilers-root", "--type=A", "--ttl=300", "--rrdatas=169.254.169.254"));

  step("Cloud NAT for the proxy subnet only",
    cmd("gcloud", "compute", "routers", "create", "egress-proxy-router", p, r, `--network=${network}`),
    cmd("gcloud", "compute", "routers", "nats", "create", "egress-proxy-nat", p, r, "--router=egress-proxy-router", "--auto-allocate-nat-external-ips",
      `--nat-custom-subnet-ip-ranges=${model.proxySubnet.name}`, "--enable-logging"));

  step("The proxy's identity: certificate keys, logs and metrics, nothing else",
    cmd("gcloud", "iam", "service-accounts", "create", sa.split("@")[0], p, "--display-name=ISOLATE-01 egress proxy"),
    cmd("gcloud", "projects", "add-iam-policy-binding", project, `--member=serviceAccount:${sa}`, "--role=roles/logging.logWriter", "--condition=None"),
    cmd("gcloud", "projects", "add-iam-policy-binding", project, `--member=serviceAccount:${sa}`, "--role=roles/monitoring.metricWriter", "--condition=None"));

  step("Secrets: the public CA bundle (compilers) and one certificate key per host (the proxy only)",
    cmd("gcloud", "secrets", "create", "egress-proxy-ca-bundle", p, "--replication-policy=automatic"),
    cmd("gcloud", "secrets", "versions", "add", "egress-proxy-ca-bundle", p, "--data-file=ca.crt"),
    // Every runtime account of a service with a network block (deploy.json).
    ...accounts.map(a => cmd("gcloud", "secrets", "add-iam-policy-binding", "egress-proxy-ca-bundle", p, `--member=serviceAccount:${a}`, "--role=roles/secretmanager.secretAccessor")),
    ...(accounts.length ? [] : ["# no deploy.json service has a network block yet: no compiler account reads the CA bundle"]),
    ...hosts.flatMap(h => [
      cmd("gcloud", "secrets", "create", `egress-proxy-cert-${slug(h)}`, p, "--replication-policy=automatic"),
      cmd("gcloud", "secrets", "versions", "add", `egress-proxy-cert-${slug(h)}`, p, `--data-file=certs/${slug(h)}.pem`),
      cmd("gcloud", "secrets", "add-iam-policy-binding", `egress-proxy-cert-${slug(h)}`, p, `--member=serviceAccount:${sa}`, "--role=roles/secretmanager.secretAccessor"),
    ]));

  step("Instance template (pinned COS image, cloud-init from generate.js) and the managed instance group",
    cmd("gcloud", "compute", "instance-templates", "create", `egress-proxy-${templateVersion}`, p, `--machine-type=${model.proxy.machineType}`,
      `--image=${model.proxy.cosImage ?? "<cos-image, pinned in step 0>"}`, "--image-project=cos-cloud", `--network=${network}`, `--subnet=${model.proxySubnet.name}`,
      `--region=${region}`, "--no-address", `--service-account=${sa}`, "--scopes=cloud-platform", "--shielded-secure-boot",
      `--metadata=google-logging-enabled=true,google-monitoring-enabled=true,cos-update-strategy=update_disabled,isolate01-config-sha256=${envoy.node.metadata.isolate01.config_sha256}`,
      "--metadata-from-file=user-data=out/cloud-init.yaml"),
    cmd("gcloud", "compute", "health-checks", "create", "http", "egress-proxy-ready", p, r, `--port=${model.proxy.healthPort}`, "--request-path=/ready", "--enable-logging"),
    cmd("gcloud", "compute", "instance-groups", "managed", "create", "egress-proxy", p, r, `--template=egress-proxy-${templateVersion}`, "--size=2",
      `--zones=${zones.join(",")}`, `--health-check=projects/${project}/regions/${region}/healthChecks/egress-proxy-ready`, "--initial-delay=120", "--target-distribution-shape=EVEN"));

  step("Internal passthrough Network Load Balancer (keeps the compiler's source address)",
    cmd("gcloud", "compute", "backend-services", "create", "egress-proxy", p, r, "--load-balancing-scheme=INTERNAL", "--protocol=TCP", "--health-checks=egress-proxy-ready", "--health-checks-region=" + region),
    cmd("gcloud", "compute", "backend-services", "add-backend", "egress-proxy", p, r, "--instance-group=egress-proxy", `--instance-group-region=${region}`),
    cmd("gcloud", "compute", "forwarding-rules", "create", "egress-proxy", p, r, "--load-balancing-scheme=INTERNAL", `--network=${network}`, `--subnet=${model.proxySubnet.name}`,
      "--address=egress-proxy-lb", "--ip-protocol=TCP", `--ports=${model.proxy.listenPort}`, "--backend-service=egress-proxy", `--backend-service-region=${region}`));

  step("Alerts: a failing health check, a spike in refusals, and access logs stopping",
    cmd("gcloud", "logging", "metrics", "create", "egress-proxy-access", p, "--description=ISOLATE-01 proxy access log lines", "--log-filter=jsonPayload.isolate01=(\"egress\" OR \"terminate\")"),
    cmd("gcloud", "logging", "metrics", "create", "egress-proxy-heartbeat", p, "--description=ISOLATE-01 proxy health-check log lines (the logging path's heartbeat)", "--log-filter=jsonPayload.isolate01=\"health\""),
    cmd("gcloud", "logging", "metrics", "create", "egress-proxy-refused", p, "--description=ISOLATE-01 proxy refusals", "--log-filter=jsonPayload.isolate01=(\"egress\" OR \"terminate\") AND jsonPayload.decision=\"refuse\""),
    cmd("gcloud", "logging", "metrics", "create", "egress-proxy-config-mismatch", p, "--description=ISOLATE-01 a proxy VM running another config than its template's",
      "--log-filter=jsonPayload.isolate01=\"config\" AND jsonPayload.match=false"),
    cmd("gcloud", "logging", "metrics", "create", "egress-proxy-unhealthy", p, "--description=ISOLATE-01 proxy VMs marked unhealthy",
      "--log-filter=resource.type=\"gce_instance_group\" AND jsonPayload.healthCheckProbeResult.healthState=\"UNHEALTHY\""),
    ...Object.keys(alertPolicies(model)).map(name => cmd("gcloud", "monitoring", "policies", "create", p, `--policy-from-file=out/alerts/${name}.json`)),
    ...((model.proxy.alerts?.notificationChannels ?? []).length ? [] : ["# classes.json proxy.alerts.notificationChannels is empty: set it before step 1, or the policies alert no one"]));

  // A regional group's fixed surge must be 0 or at least its number of zones
  // (A7): two pinned zones, so a surge of two, and never an unavailable VM.
  step("Rolling update (patching: a new template, new VMs up before old ones go)",
    cmd("gcloud", "compute", "instance-groups", "managed", "rolling-action", "start-update", "egress-proxy", p, r, `--version=template=egress-proxy-${templateVersion}`,
      `--max-surge=${zones.length}`, "--max-unavailable=0", "--type=proactive"));

  return steps;
}

export function render(steps) {
  return steps.map(s => [`# ${s.title}`, ...s.lines].join("\n")).join("\n\n") + "\n";
}

const USAGE = "usage: infra.js --plan [--deploy deploy.json] [--classes classes.json] | --apply --steps n[,n..] --deploy f --classes f [--workdir dir]";

export function parseArgs(argv) {
  const opts = { plan: false, apply: false, steps: undefined, deploy: undefined, classes: undefined, workdir: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--plan") opts.plan = true;
    else if (argv[i] === "--apply") opts.apply = true;
    else if (["--deploy", "--classes", "--steps", "--workdir"].includes(argv[i]) && argv[i + 1]) opts[argv[i].slice(2)] = argv[++i];
    else throw new Error(USAGE);
  }
  if (opts.plan && opts.apply) throw new Error(USAGE);
  return opts;
}

// What --apply would run for the chosen steps (1-based, in --plan's order),
// or why it refuses. It refuses:
// - a project outside SCRATCH_PROJECTS;
// - a command that names any other project, or none;
// - a placeholder left in a command (an unpinned image);
// - a commented-out command in a chosen step: an open choice that step 0
//   must settle in this file first.
export function applyPlan(model, steps, chosen) {
  if (!SCRATCH_PROJECTS.has(model.project)) {
    throw new Error(`--apply runs only against ${[...SCRATCH_PROJECTS].join(", ")}, not ${model.project}. ${DEFERRED}`);
  }
  const runs = [];
  for (const n of chosen) {
    if (!Number.isInteger(n) || n < 1 || n > steps.length) throw new Error(`--steps: no step ${n} (1-${steps.length})`);
    const s = steps[n - 1];
    for (const line of s.lines) {
      if (!(line instanceof Cmd)) {
        if (/^#\s+gcloud\s/.test(String(line))) throw new Error(`step ${n} (${s.title}) has an open choice, not yet settled: ${line}`);
        continue;
      }
      const text = String(line);
      if (/<[^>]+>/.test(text)) throw new Error(`step ${n}: a placeholder remains (pin it first): ${text}`);
      const named = [
        ...line.argv.flatMap(a => a.startsWith("--project=") ? [a.slice("--project=".length)] : []),
        ...(line.argv[1] === "projects" && line.argv[2] === "add-iam-policy-binding" ? [line.argv[3]] : []),
      ];
      if (!named.length) throw new Error(`step ${n}: a command names no project: ${text}`);
      const other = named.find(p => p !== model.project);
      if (other) throw new Error(`step ${n}: a command names ${other}, not ${model.project}: ${text}`);
      runs.push({ step: n, title: s.title, argv: line.argv, text });
    }
  }
  return runs;
}

// The files a command reads (--data-file, --metadata-from-file, --policy-from-file), relative
// to the workdir. Each must exist and be non-empty. A template's user-data must also carry
// the config digest its metadata names. Found in step 0: a cloud-init cut short to 0 bytes
// made a template whose VMs never started the proxy, under the config's own name.
export function inputProblems(runs, { workdir = process.cwd(), read = f => readFileSync(f, "utf8"), size = f => statSync(f).size } = {}) {
  const problems = [];
  for (const r of runs) {
    const files = r.argv.flatMap(a => {
      const m = /^--(data-file|policy-from-file|metadata-from-file)=(.+)$/.exec(a);
      if (!m) return [];
      return m[1] === "metadata-from-file" ? m[2].split(",").map(kv => ({ key: kv.slice(0, kv.indexOf("=")), file: kv.slice(kv.indexOf("=") + 1) })) : [{ key: m[1], file: m[2] }];
    });
    const digest = r.argv.join(" ").match(/isolate01-config-sha256=([0-9a-f]{64})/)?.[1];
    for (const { key, file } of files) {
      const full = path.resolve(workdir, file);
      let bytes;
      try { bytes = size(full); } catch { problems.push(`step ${r.step}: ${file} doesn't exist (in ${workdir})`); continue; }
      if (!bytes) { problems.push(`step ${r.step}: ${file} is empty`); continue; }
      if (key === "user-data") {
        const text = read(full);
        if (digest && !text.includes(digest)) problems.push(`step ${r.step}: ${file} doesn't carry config ${digest.slice(0, 12)}, the template's own`);
        // The template is named by its user-data's digest: a stale or different file is refused.
        const named = r.argv.map(a => /^egress-proxy-([0-9a-f]{12})$/.exec(a)?.[1]).find(Boolean);
        if (named && !sha256(text).startsWith(named)) problems.push(`step ${r.step}: ${file} isn't the user-data template egress-proxy-${named} is named for (regenerate it)`);
      }
    }
  }
  return problems;
}

// Runs each command in order. A create that finds its resource already there
// is recorded as "exists", so a phase can be re-run; any other failure stops.
export function apply(runs, { workdir = process.cwd(), spawn = spawnSync, log = console.log, checkInputs = inputProblems } = {}) {
  const problems = checkInputs(runs, { workdir });
  if (problems.length) throw new Error(`refusing to apply:\n  ${problems.join("\n  ")}`);
  const results = [];
  for (const r of runs) {
    log(`[step ${r.step}] ${r.text}`);
    const res = spawn(r.argv[0], r.argv.slice(1), { cwd: workdir, encoding: "utf8" });
    const stderr = res.stderr ?? "";
    if (res.status === 0) results.push({ ...r, outcome: "ran" });
    else if (/already exists|ALREADY_EXISTS/i.test(stderr)) results.push({ ...r, outcome: "exists" });
    else {
      results.push({ ...r, outcome: "failed", stderr });
      log(stderr.trim());
      throw Object.assign(new Error(`step ${r.step} failed: ${r.text}`), { results });
    }
    log(`  -> ${results.at(-1).outcome}`);
  }
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.plan && !opts.apply) throw new Error(DEFERRED);
  const model = await load(opts);
  if (opts.plan) return process.stdout.write(render(commands(model)));
  if (!opts.steps || !opts.deploy || !opts.classes) throw new Error(USAGE);
  apply(applyPlan(model, commands(model), opts.steps.split(",").map(Number)), { workdir: opts.workdir });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
