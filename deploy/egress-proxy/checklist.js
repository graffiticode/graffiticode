#!/usr/bin/env node
// ISOLATE-01 rollout step 1: the operator's checklist, generated from infra.js's own commands,
// so the two can't drift. Plan: ~/.claude/plans/isolate-01-compiler-egress.md, step 1;
// procedure: README.md, "Rollout step 1".
//
//   node deploy/egress-proxy/checklist.js [--deploy production/network.json] [--classes classes.json] > step1-checklist.md
//
// Steps 1–10 of `infra.js --plan`, each followed by read-only checks and what they should
// show. Step 11 (the rolling update) is for later patches, not step 1.

import path from "node:path";
import { load, terminatedHosts, compilerAccounts, envoyConfig, heartbeatThreshold, slug } from "./generate.js";
import { commands } from "./infra.js";

const HERE = path.dirname(new URL(import.meta.url).pathname);

// Read-only checks per step, by step number: [command, what it should show].
function checks(model) {
  const p = `--project=${model.project}`;
  const r = `--region=${model.region}`;
  const n = model.network;
  const sa = model.proxy.serviceAccount;
  const classes = Object.values(model.classes);
  const accounts = compilerAccounts(model);
  const hosts = terminatedHosts(model);
  return {
    1: [
      [`gcloud compute networks subnets list ${p} --filter=network:${n} --format="table(name,ipCidrRange,stackType)"`,
        `${classes.length + 1} subnets, all IPV4_ONLY: ${model.proxySubnet.name} ${model.proxySubnet.cidr}, ${classes.map(c => `${c.name} ${c.cidr}`).join(", ")}`],
      [`gcloud compute addresses describe egress-proxy-lb ${p} ${r} --format="value(address,status,purpose)"`,
        `${model.loadBalancerAddress}  RESERVED  GCE_ENDPOINT`],
    ],
    2: [
      [`gcloud compute network-firewall-policies describe compilers-egress --global ${p} --format="yaml(associations,rules)"`,
        `associated with ${n}; rule 100 allows tcp:${model.proxy.listenPort} to ${model.loadBalancerAddress}/32, rule 200 denies DNS (tcp/udp 53, tcp 853), rule 1000 denies all, all from the compiler ranges, 200 and 1000 logged`],
    ],
    3: [
      [`gcloud compute firewall-rules list ${p} --filter=network:${n} --format="table(name,direction,priority)"`,
        "6 rules: egress-proxy-allow-compilers, -allow-health, -deny-internal (900), -allow-resolvers (950), -allow-web (1000), -deny-rest (65000)"],
    ],
    4: [
      [`gcloud dns managed-zones describe compilers-root ${p} --format="value(dnsName,visibility,privateVisibilityConfig.networks[].networkUrl.basename())"`,
        `.  private  ${n}`],
      [`gcloud dns record-sets list --zone=compilers-root ${p} --format="table(name,type,rrdatas.list())"`,
        "NS, SOA, and metadata.google.internal. A 169.254.169.254: nothing else"],
    ],
    5: [
      [`gcloud compute routers nats describe egress-proxy-nat --router=egress-proxy-router ${p} ${r} --format="value(sourceSubnetworkIpRangesToNat,subnetworks[].name.basename(),logConfig.enable)"`,
        `LIST_OF_SUBNETWORKS  ${model.proxySubnet.name}  True`],
    ],
    6: [
      [`gcloud projects get-iam-policy ${model.project} --flatten=bindings --filter="bindings.members:${sa}" --format="value(bindings.role)"`,
        "exactly roles/logging.logWriter and roles/monitoring.metricWriter"],
    ],
    7: [
      [`gcloud secrets get-iam-policy egress-proxy-ca-bundle ${p} --format="value(bindings.role,bindings.members)"`,
        `secretAccessor for ${accounts.join(", ")} only`],
      ...hosts.map(h => [`gcloud secrets get-iam-policy egress-proxy-cert-${slug(h)} ${p} --format="value(bindings.role,bindings.members)"`, `secretAccessor for ${sa} only`]),
      [`gcloud projects get-iam-policy ${model.project} --flatten=bindings --filter="bindings.role:secretmanager" --format="value(bindings.role,bindings.members)"`,
        "nothing at project level that reaches these secrets (or only principals you've accepted at the pre-flight gate)"],
    ],
    8: [
      [`gcloud compute instance-groups managed list-instances egress-proxy ${p} ${r} --format="table(instance.basename(),instance.scope(zones).segment(0),status,version.instanceTemplate.basename())"`,
        `2 instances, one in each of ${model.proxy.zones.join(" and ")}, RUNNING, on the template just created`],
      [`gcloud compute instances get-serial-port-output <instance> --zone=<zone> ${p} | grep -E "egress-(resolver|firewall|certs|envoy)"`,
        "for each VM, in order: Finished egress-resolver, egress-firewall (its self-check), egress-certs; Started egress-envoy"],
    ],
    9: [
      [`gcloud compute forwarding-rules describe egress-proxy ${p} ${r} --format="value(IPAddress,ports.list(),loadBalancingScheme)"`,
        `${model.loadBalancerAddress}  ${model.proxy.listenPort}  INTERNAL`],
      [`gcloud compute backend-services get-health egress-proxy ${p} ${r} --format="value(status.healthStatus[].healthState)"`,
        "HEALTHY;HEALTHY (allow a few minutes after boot)"],
    ],
    10: [
      [`gcloud logging metrics list ${p} --filter="name:egress-proxy" --format="value(name)"`,
        "egress-proxy-access, -config-mismatch, -heartbeat, -refused, -unhealthy"],
      [`gcloud monitoring policies list ${p} --format="table(displayName,enabled)"`,
        `4 ISOLATE-01 policies, enabled; the heartbeat floor is ${heartbeatThreshold(model)} per 5 minutes`],
    ],
  };
}

export function checklist(model) {
  const steps = commands(model);
  const expect = checks(model);
  const p = `--project=${model.project}`;
  const digest = envoyConfig(model).node.metadata.isolate01.config_sha256;
  const hosts = terminatedHosts(model);
  const out = [];
  const add = (...lines) => out.push(...lines);
  add("# ISOLATE-01 rollout step 1: production egress-proxy infrastructure", "",
    `Generated by \`deploy/egress-proxy/checklist.js\` from \`infra.js\`'s commands for \`${model.project}\`. The procedure is in`,
    "`deploy/egress-proxy/README.md`, \"Rollout step 1\". This changes no compiler: none uses the proxy until its",
    "step 3 candidate. Run the commands from your working directory (`<workdir>`, below), in order. Each step ends with",
    "read-only checks: stop if any shows something else.", "",
    `Expected config digest: \`${digest}\``, "");

  add("## 0. Pre-flight (read-only, and the gate)", "",
    "- [ ] **Who could start a VM as the proxy?** Anyone with `iam.serviceAccounts.actAs` on `egress-proxy`, at project",
    "  level through Editor or Owner, can run a VM as it and read every certificate key. In step 0 the default Compute",
    "  Engine account held Editor (removed there). List them, and decide what to remove or accept *before* step 7",
    "  stores the keys. Checked 2026-10-18: Editor is held only by the Google APIs service agent",
    "  (`<number>@cloudservices.gserviceaccount.com`, which instance groups need), and the default Compute Engine",
    "  account holds none. Owners admin@ and jeff@artcompiler.com and kevin.m.dyer@gmail.com are accepted (Jeff).",
    "  Re-run it, and stop if anything else appears:",
    "  ```",
    `  gcloud projects get-iam-policy ${model.project} --flatten=bindings --filter="bindings.role:(roles/editor OR roles/owner OR roles/iam.serviceAccountUser OR roles/iam.serviceAccountTokenCreator)" --format="table(bindings.role,bindings.members)"`,
    "  ```",
    "- [ ] gcloud is logged in as the account that owns this rollout, and the project is right:",
    "  ```",
    `  gcloud auth list --filter=status:ACTIVE --format="value(account)"; gcloud projects describe ${model.project} --format="value(projectId,lifecycleState)"`,
    "  ```",
    "- [ ] Nothing of the proxy exists yet (each should say it isn't found):",
    "  ```",
    `  gcloud compute networks describe ${model.network} ${p}; gcloud iam service-accounts describe ${model.proxy.serviceAccount} ${p}`,
    "  ```", "");

  add("## Preparation (local, offline)", "",
    "- [ ] The production CA: created 2026-10-18 in `~/graffiticode-egress-ca` (`ca.key` owner-only), distinct from",
    "  step 0's `~/isolate01-ca`. SHA-256 fingerprint",
    "  `BF:5F:CB:8D:7D:D1:3D:69:33:2C:60:0F:BE:3A:44:40:F8:AF:04:BE:6E:6D:9E:AF:B4:A7:D5:64:1D:F3:EC:5F`. Back the",
    "  key up offline, outside any synced folder. Check it's that CA:",
    "  `openssl x509 -in ~/graffiticode-egress-ca/ca.crt -noout -fingerprint -sha256`",
    `- [ ] Issue the ${hosts.length} host certificates into \`<workdir>/certs\`:`,
    `  \`deploy/egress-proxy/issue-certs.sh issue ~/graffiticode-egress-ca <workdir>/certs ${hosts.join(" ")}\``,
    "- [ ] Copy the CA's public certificate: `cp ~/graffiticode-egress-ca/ca.crt <workdir>/ca.crt`",
    "- [ ] Generate (to a file, not through a pipe):",
    "  `node deploy/egress-proxy/generate.js --deploy deploy/egress-proxy/production/network.json --out <workdir>/out > <workdir>/generate.log`",
    `  and check its first line says \`config_sha256 ${digest}\`, and \`<workdir>/out/cloud-init.yaml\` is non-empty.`,
    "- [ ] Validate on the pinned Envoy (`deploy/egress-proxy/validate/cloudbuild.yaml`, run in the scratch project as in",
    "  step 0): `configuration 'envoy.json' OK`, no deprecation warning.",
    "- [ ] Create the alert channel: email to jeff@artcompiler.com (decided 2026-10-18; channels exist only in",
    "  `gcloud beta`, which may ask to install the component once):",
    "  ```bash",
    `  gcloud beta monitoring channels create ${p} --display-name="ISOLATE-01 egress proxy" --type=email --channel-labels=email_address=jeff@artcompiler.com --format="value(name)"`,
    "  ```",
    "  Put the printed `projects/.../notificationChannels/<id>` in `proxy.alerts.notificationChannels` in",
    "  `deploy/egress-proxy/classes.json`, and regenerate. Only the alert files change: the template and its digest don't.",
    "  Without it the policies alert no one.", "");

  steps.slice(0, 10).forEach((s, i) => {
    const n = i + 1;
    add(`## ${n}. ${s.title}`, "");
    const cmds = s.lines.filter(l => !String(l).startsWith("#"));
    const notes = s.lines.filter(l => String(l).startsWith("#")).map(l => String(l).replace(/^#\s*/, ""));
    for (const note of notes) add(`> ${note}`);
    if (notes.length) add("");
    if (n === 8) {
      // --apply's input guard doesn't run in production: check by hand what it checks.
      const name = cmds.map(String).join(" ").match(/instance-templates create egress-proxy-([0-9a-f]{12}) /)?.[1];
      add("- [ ] Before running: the template is named by its user-data's logical digest, so the file must be the one it",
        "  names (`--apply` checks this; by hand here). Step 0 caught a 0-byte cloud-init this way:", "  ```bash",
        "  node deploy/egress-proxy/user-data-digest.js out/cloud-init.yaml", "  ```",
        `  Expect: it starts with \`${name}\`, and the file is about 40 KB (the Envoy config inside is gzipped). Not`,
        "  `shasum`: gzip's bytes differ between machines, so the template is named by the decoded content.");
    }
    add("- [ ] Run:", "  ```bash", ...cmds.map(c => `  ${c}`), "  ```");
    if (n === 7 || n === 10) add("  Run it once: `secrets versions add` and `monitoring policies create` aren't idempotent.");
    add("- [ ] Check:");
    for (const [c, want] of expect[n] ?? []) add("  ```bash", `  ${c}`, "  ```", `  Expect: ${want}`);
    add("");
  });

  add("## Done", "",
    "- [ ] Every VM runs the expected config. Gather and judge, as `verify-rollout.js` prints:",
    "  ```bash",
    `  node deploy/egress-proxy/verify-rollout.js --expect ${digest} --project ${model.project} --region ${model.region}`,
    "  ```",
    "  The judged result must be `ok: true`, with both VMs `match: true`. The first reports come about three minutes after boot.",
    "- [ ] The heartbeat is flowing: about 360 health-check lines per VM per 5 minutes.",
    "  ```bash",
    `  gcloud logging read 'jsonPayload.isolate01="health"' ${p} --freshness=5m --limit=5000 --format="value(resource.labels.instance_id)" | sort | uniq -c`,
    "  ```",
    "- [ ] Record in the plan: the date, the config digest, the template name, and the CA's custody.",
    "- [ ] Keep `<workdir>/certs` and the CA offline. Only the per-host secrets are in Secret Manager.", "",
    "Next is rollout step 2: the `@graffiticode/l0000` publish with `./egress`, then the per-language bootstrap commits.");
  return out.join("\n") + "\n";
}

function parseArgs(argv) {
  const opts = { deploy: path.join(HERE, "production/network.json"), classes: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (["--deploy", "--classes"].includes(argv[i]) && argv[i + 1]) opts[argv[i].slice(2)] = argv[++i];
    else throw new Error("usage: checklist.js [--deploy production/network.json] [--classes classes.json]");
  }
  return opts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  load(parseArgs(process.argv.slice(2))).then(m => process.stdout.write(checklist(m))).catch(e => { console.error(e.message); process.exit(1); });
}
