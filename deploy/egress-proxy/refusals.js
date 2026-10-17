#!/usr/bin/env node
// ISOLATE-01 inventory (rollout step 3): what a staged candidate's class was
// refused. Plan: ~/.claude/plans/isolate-01-compiler-egress.md, step 3 and A18.
//
//   node deploy/egress-proxy/refusals.js --class <compilers-...> --since <ISO time> [--project graffiticode]
//       Prints the Cloud Logging query (a gcloud command) for the operator to run.
//   node deploy/egress-proxy/refusals.js --class <compilers-...> --parse <entries.json>
//       Reads what that command saved (a JSON array, or one entry per line) and
//       prints each refused destination with its reason and count.
//
// Nothing here contacts the cloud: the operator runs the printed command.

import { readFile } from "node:fs/promises";

const CLASS = /^compilers-[a-z0-9-]+$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

// A connection-level line has no decision field: an unknown SNI is NR (no
// filter chain), an RBAC refusal names rbac in its termination details.
export function tcpDecision(payload) {
  const flags = String(payload.flags ?? "");
  const termination = String(payload.termination ?? "");
  return /(^|,)NR(,|$)/.test(flags) || /rbac/i.test(termination) ? "refuse" : "allow";
}

export function isRefusal(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.isolate01 === "egress" || payload.isolate01 === "terminate") {
    return payload.decision === "refuse" || (Number(payload.code) === 403 && payload.refused && payload.refused !== "-");
  }
  if (payload.isolate01 === "terminate-tcp" || payload.isolate01 === "egress-tcp") return tcpDecision(payload) === "refuse";
  return false;
}

const reasonOf = p => {
  if (p.isolate01?.endsWith("-tcp")) return /(^|,)NR(,|$)/.test(String(p.flags)) ? "no-filter-chain" : "rbac";
  return p.reason && p.reason !== "-" ? p.reason : p.refused;
};
const targetOf = p => {
  const pick = [p.target, p.host, p.sni].find(x => x && x !== "-");
  return pick ?? `(source ${p.downstream ?? "?"})`;
};

export function refusalFilter({ cls, since }) {
  if (!CLASS.test(cls ?? "")) throw new Error("--class must be a compiler class, compilers-<name>");
  if (!ISO.test(since ?? "")) throw new Error("--since must be an ISO 8601 time, e.g. 2026-10-20T00:00:00Z");
  return [
    'resource.type="gce_instance"',
    'jsonPayload.isolate01=("egress" OR "terminate" OR "terminate-tcp")',
    `jsonPayload.class="${cls}"`,
    '(jsonPayload.decision="refuse" OR jsonPayload.isolate01="terminate-tcp")',
    `timestamp>="${since}"`,
  ].join(" AND ");
}

export function command({ project = "graffiticode", cls, since }) {
  const filter = refusalFilter({ cls, since });
  return `gcloud logging read '${filter}' --project=${project} --format=json --limit=100000 > refusals-${cls}.json`;
}

// Log entries (gcloud's JSON) → refused destinations, most refused first.
export function refusedDestinations(entries, { cls } = {}) {
  const byKey = new Map();
  for (const e of entries) {
    const p = e.jsonPayload ?? e;
    if (cls && p.class !== cls) continue;
    if (!isRefusal(p)) continue;
    const target = targetOf(p);
    const reason = reasonOf(p);
    const key = `${target}\u0000${reason}`;
    const at = e.timestamp ?? p.start;
    const row = byKey.get(key) ?? { target, reason, count: 0, first: at, last: at, probes: [] };
    row.count++;
    if (at && (!row.first || at < row.first)) row.first = at;
    if (at && (!row.last || at > row.last)) row.last = at;
    if (p.probe && p.probe !== "-" && !row.probes.includes(p.probe)) row.probes.push(p.probe);
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.target.localeCompare(b.target));
}

export function parseEntries(text) {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith("[")) return JSON.parse(t);
  return t.split("\n").filter(Boolean).map(l => JSON.parse(l));
}

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!["--class", "--since", "--project", "--parse"].includes(flag) || !argv[i + 1]) {
      throw new Error("usage: refusals.js --class <compilers-...> (--since <ISO time> [--project p] | --parse <entries.json>)");
    }
    opts[flag.slice(2)] = argv[++i];
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.parse) {
    const rows = refusedDestinations(parseEntries(await readFile(opts.parse, "utf8")), { cls: opts.class });
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return;
  }
  process.stdout.write(command({ project: opts.project, cls: opts.class, since: opts.since }) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
