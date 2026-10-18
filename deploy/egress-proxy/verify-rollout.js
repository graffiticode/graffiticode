#!/usr/bin/env node
// ISOLATE-01 A25: is every egress proxy VM running the expected config?
// Plan: ~/.claude/plans/isolate-01-compiler-egress.md, "Config digest".
//
//   node deploy/egress-proxy/verify-rollout.js --expect <config_sha256> [--project p] [--region r] [--size 2]
//       Prints the gcloud commands that save the group's instances and the
//       recent envoy-config-report lines, for the operator to run.
//   node deploy/egress-proxy/verify-rollout.js --expect <config_sha256> --instances <instances.json> --logs <entries.json> [--size 2]
//       Judges them: exits 0 only if every instance's template carries the
//       expected digest and its latest report since it was created says it
//       runs that digest with match: true.
//
// Nothing here contacts the cloud. `generate.js` prints the expected digest.

import { readFile } from "node:fs/promises";

const SHA = /^[0-9a-f]{64}$/;

const metadataItem = (instance, key) => (instance.metadata?.items ?? []).find(i => i.key === key)?.value;

// instances: `gcloud compute instances describe` JSON, one per group member.
// entries: Cloud Logging entries holding envoy-config-report lines.
export function verifyRollout({ expect, instances, entries, size }) {
  if (!SHA.test(expect ?? "")) throw new Error("--expect must be a config_sha256 (64 hex characters)");
  const problems = [];
  const reports = entries
    .map(e => ({ at: e.timestamp, ...(e.jsonPayload ?? e) }))
    .filter(r => r.isolate01 === "config" && r.at);
  if (size !== undefined && instances.length !== size) problems.push(`the group has ${instances.length} instances, not ${size}`);
  if (!instances.length) problems.push("no instances");
  const rows = instances.map(instance => {
    const name = instance.name;
    const created = instance.creationTimestamp;
    const template = metadataItem(instance, "isolate01-config-sha256");
    const latest = reports
      .filter(r => r.instance === name && (!created || Date.parse(r.at) > Date.parse(created)))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    const row = { name, template, reported: latest?.config_sha256, match: latest?.match, at: latest?.at };
    if (template !== expect) problems.push(`${name}: its template carries ${template ?? "no digest"}, not ${expect}`);
    if (!latest) problems.push(`${name}: no config report since it was created (${created})`);
    else {
      if (latest.config_sha256 !== expect) problems.push(`${name}: still running ${latest.config_sha256} (the previous config?), not ${expect}`);
      if (latest.match !== true) problems.push(`${name}: reports match: ${latest.match}${latest.error ? ` (${latest.error})` : ""}`);
    }
    return row;
  });
  return { ok: problems.length === 0, problems, instances: rows };
}

export function commands({ expect, project = "graffiticode", region = "us-central1" }) {
  return [
    "# 1. the group's instances, described (instances.json):",
    `gcloud compute instance-groups managed list-instances egress-proxy --project=${project} --region=${region} --format='value(instance.basename(),instance.scope(zones).segment(0))' \\`,
    `  | while read -r name zone; do gcloud compute instances describe "$name" --zone="$zone" --project=${project} --format=json; done | jq -s . > instances.json`,
    "# 2. the reports of the last hour (entries.json):",
    `gcloud logging read 'resource.type="gce_instance" AND jsonPayload.isolate01="config"' --project=${project} --freshness=1h --format=json > entries.json`,
    "# 3. judge:",
    `node deploy/egress-proxy/verify-rollout.js --expect ${expect} --instances instances.json --logs entries.json --size 2`,
  ].join("\n");
}

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!["--expect", "--instances", "--logs", "--project", "--region", "--size"].includes(flag) || !argv[i + 1]) {
      throw new Error("usage: verify-rollout.js --expect <config_sha256> [--instances instances.json --logs entries.json] [--size 2] [--project p] [--region r]");
    }
    opts[flag.slice(2)] = argv[++i];
  }
  if (opts.size !== undefined) opts.size = Number(opts.size);
  return opts;
}

const readJson = async file => {
  const t = (await readFile(file, "utf8")).trim();
  return t.startsWith("[") ? JSON.parse(t) : t.split("\n").filter(Boolean).map(l => JSON.parse(l));
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!SHA.test(opts.expect ?? "")) throw new Error("--expect must be a config_sha256 (64 hex characters)");
  if (!opts.instances || !opts.logs) {
    process.stdout.write(commands(opts) + "\n");
    return;
  }
  const result = verifyRollout({ expect: opts.expect, instances: await readJson(opts.instances), entries: await readJson(opts.logs), size: opts.size });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
