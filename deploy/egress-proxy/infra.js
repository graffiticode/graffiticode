#!/usr/bin/env node
// ISOLATE-01: the infrastructure for the egress proxy, as the gcloud commands
// that create it. Plan: ~/.claude/plans/isolate-01-compiler-egress.md
// ("The proxy", rollout steps 0 and 1). Runbook: README.md.
//
//   node deploy/egress-proxy/infra.js --plan [--deploy deploy.json] [--classes classes.json]
//
// Deployment is deferred (Jeff, 2026-10-14): this prints the commands for
// review and never runs them. Without --plan it refuses.

import { load, terminatedHosts, slug, BLOCKED, compilerAccounts, alertPolicies } from "./generate.js";

export const DEFERRED = "deployment deferred (ISOLATE-01): infra.js only prints its commands; run with --plan";

const q = s => (/^[A-Za-z0-9_./:=@,+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);
const cmd = (...args) => args.flat().filter(a => a !== null && a !== undefined && a !== false).map(String).map(q).join(" ");

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
  const steps = [];
  const step = (title, ...lines) => steps.push({ title, lines });

  step("Compiler VPC and subnets (IPv4 only)",
    cmd("gcloud", "compute", "networks", "create", network, p, "--subnet-mode=custom"),
    cmd("gcloud", "compute", "networks", "subnets", "create", model.proxySubnet.name, p, r, `--network=${network}`, `--range=${model.proxySubnet.cidr}`, "--stack-type=IPV4_ONLY"),
    ...classes.map(c => cmd("gcloud", "compute", "networks", "subnets", "create", c.name, p, r, `--network=${network}`, `--range=${c.cidr}`, "--stack-type=IPV4_ONLY")));

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
    cmd("gcloud", "compute", "firewall-rules", "create", "egress-proxy-deny-internal", p, `--network=${network}`, "--direction=EGRESS", "--action=DENY", "--rules=all",
      `--destination-ranges=${[...BLOCKED, ...classes.map(c => c.cidr), `${lb}/32`].join(",")}`, `--target-service-accounts=${sa}`, "--priority=900", "--enable-logging"),
    cmd("gcloud", "compute", "firewall-rules", "create", "egress-proxy-allow-resolvers", p, `--network=${network}`, "--direction=EGRESS", "--action=ALLOW",
      "--rules=tcp:53,udp:53", `--destination-ranges=${model.proxy.resolvers.map(x => `${x}/32`).join(",")}`, `--target-service-accounts=${sa}`, "--priority=950"),
    cmd("gcloud", "compute", "firewall-rules", "create", "egress-proxy-allow-web", p, `--network=${network}`, "--direction=EGRESS", "--action=ALLOW",
      "--rules=tcp:80,tcp:443", "--destination-ranges=0.0.0.0/0", `--target-service-accounts=${sa}`, "--priority=1000"),
    cmd("gcloud", "compute", "firewall-rules", "create", "egress-proxy-deny-rest", p, `--network=${network}`, "--direction=EGRESS", "--action=DENY", "--rules=all",
      "--destination-ranges=0.0.0.0/0", `--target-service-accounts=${sa}`, "--priority=65000"));

  step("DNS: compilers resolve nothing but the metadata server",
    cmd("gcloud", "dns", "response-policies", "create", "compilers-dns-lockdown", p, `--networks=${network}`, "--description=ISOLATE-01: compilers resolve no public name"),
    cmd("gcloud", "dns", "response-policies", "rules", "create", "metadata", p, "--response-policy=compilers-dns-lockdown", "--dns-name=metadata.google.internal.", "--behavior=bypassResponsePolicy"),
    "# OPEN until rollout step 0 confirms which form makes every other name NXDOMAIN without the query leaving Google:",
    `#   gcloud dns response-policies rules create refuse-all ${p} --response-policy=compilers-dns-lockdown --dns-name='*.' --local-data=...`,
    `#   gcloud dns managed-zones create compilers-root ${p} --dns-name=. --visibility=private --networks=${network} --description='ISOLATE-01: empty root'`);

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
    cmd("gcloud", "compute", "instance-templates", "create", "egress-proxy-<template-version>", p, `--machine-type=${model.proxy.machineType}`,
      `--image=${model.proxy.cosImage ?? "<cos-image, pinned in step 0>"}`, "--image-project=cos-cloud", `--network=${network}`, `--subnet=${model.proxySubnet.name}`,
      `--region=${region}`, "--no-address", `--service-account=${sa}`, "--scopes=cloud-platform", "--shielded-secure-boot",
      "--metadata=google-logging-enabled=true,google-monitoring-enabled=true,cos-update-strategy=update_disabled",
      "--metadata-from-file=user-data=out/cloud-init.yaml"),
    cmd("gcloud", "compute", "health-checks", "create", "http", "egress-proxy-ready", p, r, `--port=${model.proxy.healthPort}`, "--request-path=/ready", "--enable-logging"),
    cmd("gcloud", "compute", "instance-groups", "managed", "create", "egress-proxy", p, r, "--template=egress-proxy-<template-version>", "--size=2",
      `--zones=${zones.join(",")}`, "--health-check=egress-proxy-ready", "--initial-delay=120", "--target-distribution-shape=EVEN"));

  step("Internal passthrough Network Load Balancer (keeps the compiler's source address)",
    cmd("gcloud", "compute", "backend-services", "create", "egress-proxy", p, r, "--load-balancing-scheme=INTERNAL", "--protocol=TCP", "--health-checks=egress-proxy-ready", "--health-checks-region=" + region),
    cmd("gcloud", "compute", "backend-services", "add-backend", "egress-proxy", p, r, "--instance-group=egress-proxy", `--instance-group-region=${region}`),
    cmd("gcloud", "compute", "forwarding-rules", "create", "egress-proxy", p, r, "--load-balancing-scheme=INTERNAL", `--network=${network}`, `--subnet=${model.proxySubnet.name}`,
      `--address=${lb}`, "--ip-protocol=TCP", `--ports=${model.proxy.listenPort}`, "--backend-service=egress-proxy", `--backend-service-region=${region}`));

  step("Alerts: a failing health check, a spike in refusals, and access logs stopping",
    cmd("gcloud", "logging", "metrics", "create", "egress-proxy-access", p, "--description=ISOLATE-01 proxy access log lines", "--log-filter=jsonPayload.isolate01=(\"egress\" OR \"terminate\")"),
    cmd("gcloud", "logging", "metrics", "create", "egress-proxy-refused", p, "--description=ISOLATE-01 proxy refusals", "--log-filter=jsonPayload.isolate01=(\"egress\" OR \"terminate\") AND jsonPayload.decision=\"refuse\""),
    cmd("gcloud", "logging", "metrics", "create", "egress-proxy-unhealthy", p, "--description=ISOLATE-01 proxy VMs marked unhealthy",
      "--log-filter=resource.type=\"gce_instance_group\" AND jsonPayload.healthCheckProbeResult.healthState=\"UNHEALTHY\""),
    ...Object.keys(alertPolicies(model)).map(name => cmd("gcloud", "alpha", "monitoring", "policies", "create", p, `--policy-from-file=out/alerts/${name}.json`)),
    ...((model.proxy.alerts?.notificationChannels ?? []).length ? [] : ["# classes.json proxy.alerts.notificationChannels is empty: set it before step 1, or the policies alert no one"]));

  // A regional group's fixed surge must be 0 or at least its number of zones
  // (A7): two pinned zones, so a surge of two, and never an unavailable VM.
  step("Rolling update (patching: a new template, new VMs up before old ones go)",
    cmd("gcloud", "compute", "instance-groups", "managed", "rolling-action", "start-update", "egress-proxy", p, r, "--version=template=egress-proxy-<new-template-version>",
      `--max-surge=${zones.length}`, "--max-unavailable=0", "--type=proactive"));

  return steps;
}

export function render(steps) {
  return steps.map(s => [`# ${s.title}`, ...s.lines].join("\n")).join("\n\n") + "\n";
}

export function parseArgs(argv) {
  const opts = { plan: false, deploy: undefined, classes: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--plan") opts.plan = true;
    else if (["--deploy", "--classes"].includes(argv[i]) && argv[i + 1]) opts[argv[i].slice(2)] = argv[++i];
    else throw new Error("usage: infra.js --plan [--deploy deploy.json] [--classes classes.json]");
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.plan) throw new Error(DEFERRED);
  const model = await load(opts);
  process.stdout.write(render(commands(model)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
