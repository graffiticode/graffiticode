#!/usr/bin/env node
// ISOLATE-01, the D6 wave: is every legacy compiler's reachable revision on the egress proxy?
// The legacy compilers deploy from their own repos (not deploy.json), so the deploy CLI's
// release-check doesn't see them. This applies the same checks to them, read-only.
// Plan: ~/.claude/plans/isolate-01-d6-wave.md.
//
//   node scripts/legacy-network-check.js [--only l0002,l0011] [--pending l0137,l0170]
//
// It also lists the project's services: any lNNNN-<branch> staging service must be on its
// language's class too.
//
// Each service in deploy/egress-proxy/production/network.json marked "legacy": every revision its
// traffic can reach (serving or tagged) must have the network interface, all-traffic egress,
// the exact proxy variables and the CA mount. l0158 and l0160 must carry no LEARNOSITY_*
// (they once read Learnosity credentials). --pending names services not yet moved: they're
// listed, but don't fail the run. Exits 1 if any other service is not ready.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { networkProblems, forbiddenEnvProblems, reachableRevisions } from "../packages/deploy/src/release.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PROJECT = "graffiticode";
const REGION = "us-central1";
const FORBIDDEN = { l0158: ["LEARNOSITY_KEY", "LEARNOSITY_SECRET"], l0160: ["LEARNOSITY_KEY", "LEARNOSITY_SECRET"] };

export const legacyServices = network => Object.entries(network.services)
  .filter(([, s]) => s.legacy === true)
  .map(([name, s]) => ({ name, network: s.network, forbiddenEnv: FORBIDDEN[name] ?? [] }));

// One service's verdict. `cloud(args)` returns gcloud's JSON for args (project and region added).
export async function checkService(svc, { cloud }) {
  const service = await cloud(["run", "services", "describe", svc.name]);
  const revisions = reachableRevisions(service);
  if (!revisions.length) return { service: svc.name, ready: false, why: ["no reachable revision"] };
  const context = { config: { network: svc.network, forbiddenEnv: svc.forbiddenEnv } };
  const network = await networkProblems(context, revisions, { cloud });
  const forbidden = await forbiddenEnvProblems(context, revisions, { cloud });
  const why = [
    ...network.map(p => `${p.revision}: ${p.problems.join(", ")}`),
    ...forbidden.map(p => `${p.revision}: ${p.problem === "unreadable" ? "environment unreadable" : `carries ${p.env.join(", ")}`}`),
  ];
  return { service: svc.name, revisions, ready: why.length === 0, ...(why.length ? { why } : {}) };
}

export async function checkAll(services, { cloud, pending = new Set() }) {
  const results = [];
  for (const svc of services) results.push({ ...(await checkService(svc, { cloud })), ...(pending.has(svc.name) ? { pending: true } : {}) });
  return { results, ok: results.every(r => r.ready || r.pending) };
}

// A staging deploy makes lNNNN-<branch> (cloudbuild.staging.yaml). It's a compiler too, so it
// must be on its language's class; one whose language isn't legacy is refused outright.
export const STAGING = /^(l\d{4})-[a-z0-9-]+$/;
export function stagingServices(names, legacy) {
  const byName = new Map(legacy.map(s => [s.name, s]));
  return names.filter(n => STAGING.test(n)).map(n => {
    const base = byName.get(n.match(STAGING)[1]);
    return base ? { ...base, name: n, staging: true } : { name: n, staging: true, unknown: true };
  });
}

const run = promisify(execFile);
const gcloud = async args => JSON.parse((await run("gcloud", [...args, `--project=${PROJECT}`, `--region=${REGION}`, "--format=json"], { maxBuffer: 16 * 1024 * 1024 })).stdout);

async function main() {
  const argv = process.argv.slice(2);
  const list = flag => { const i = argv.indexOf(flag); return i >= 0 ? new Set((argv[i + 1] ?? "").split(",").filter(Boolean)) : null; };
  const only = list("--only");
  const pending = list("--pending") ?? new Set();
  const network = JSON.parse(await readFile(path.join(ROOT, "deploy/egress-proxy/production/network.json"), "utf8"));
  const legacy = legacyServices(network);
  // Every staging service in the project, whatever --only says: none should exist off the proxy.
  const names = (await gcloud(["run", "services", "list"])).map(s => s.metadata.name);
  const staging = stagingServices(names, legacy);
  const services = [...legacy.filter(s => !only || only.has(s.name)), ...staging.filter(s => !s.unknown)];
  if (!services.length) throw new Error("no legacy services selected");
  const checked = await checkAll(services, { cloud: gcloud, pending });
  const results = [...checked.results, ...staging.filter(s => s.unknown).map(s => ({ service: s.name, ready: false, why: ["a staging service of a language that isn't legacy"] }))];
  const ok = checked.ok && !staging.some(s => s.unknown);
  for (const r of results) console.log(`${r.service}: ${r.ready ? "ok" : r.pending ? "pending" : "NOT READY"}${r.why ? ` (${r.why.join("; ")})` : ""}`);
  console.log(ok ? `ok: ${results.filter(r => r.ready).length} on the proxy` : "NOT READY");
  process.exit(ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
