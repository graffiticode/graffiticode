#!/usr/bin/env node
// AT-11, the operator's collector (ISOLATE-01; plan: ~/.claude/plans/isolate-01-compiler-egress.md,
// "Running AT-11"). A Cloud Run job has one identity, and a compiler job can't read logs or
// reach Logging, so no job can judge itself. The collector, run by the operator with their own
// credentials (roles/run.developer on the jobs, roles/logging.viewer and
// roles/logging.privateLogViewer; no compiler identity):
//   1. makes a run nonce and starts every identity-bound job with it, recording each execution;
//   2. waits for them, and refuses a missing execution or mixed image digests;
//   3. reads each job's one AT11-EVIDENCE line from Cloud Logging, by execution and nonce;
//   4. sends its own outside DNS control query first, with a fresh label;
//   5. waits for log delivery, then fetches the proxy's access lines, the ISOLATE01-REJECT and
//      firewall-log hits and the authoritative DNS log for a window covering the compiler's
//      queries and the control's, retrying a bounded number of times;
//   6. judges everything together, and writes .gc-deploy/at11/<nonce>/.
// The jobs' own verdicts are inputs, never the verdict.
//
//   node scripts/at11/collect.js --config collect.json [--out dir]
//
// collect.json:
//   project:  "graffiticode"
//   region:   "us-central1"
//   control:  "at11-iam-control"                          the control's IAM job
//   compilers: [{ subject: "l0176-run", net: "at11-net-l0176", iam: "at11-iam-l0176" }, ...]
//             every compiler account (compilerInventory: deploy.json's languages and every
//             lNNNN-run / lNNNNr-run account in the project) must be here or in `excluded`
//   excluded: [{ subject: "l0001-run", reason: "..." }, ...]   each with a stated reason
//   dnsExfil: "<domain we run>"                           the same domain the net jobs use
//   dnsLog:   { filter: "<Cloud Logging filter for the domain's query log>" }
//   blocked:  { compilerSubnets: [...], proxySubnet: "...", loadBalancer: "..." }
//   retries:  { attempts: 6, waitMs: 30000 }
// Nothing here is run until rollout step 7 (deployment deferred).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { promises as dns } from "node:dns";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { parseArgs } from "./lib.js";
import { settleNetwork, judgeDnsRow, verdictOf } from "./net.js";
import { combine } from "./iam.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const EVIDENCE = "AT11-EVIDENCE ";

// A kernel log entry's text: COS's journal entries carry it as jsonPayload.MESSAGE.
export const kernelText = e => e.jsonPayload?.MESSAGE ?? e.textPayload ?? "";

// Every compiler account (step 7). deploy.json covers only the languages released by the deploy
// CLI; others deploy from their own repositories, each with its own lNNNN-run account. So the
// inventory is the union of deploy.json's language services and every lNNNN-run / lNNNNr-run
// account in the project.
export const COMPILER_ACCOUNT = /^l\d{4}r?-run@graffiticode\.iam\.gserviceaccount\.com$/;
export function compilerInventory({ deployServices = {}, serviceAccounts = [] }) {
  const accounts = new Map();
  for (const [name, entry] of Object.entries(deployServices)) {
    if (!/^l\d{4}r?$/.test(name)) continue;
    const account = entry.runtimeServiceAccount ?? `${name}-run@graffiticode.iam.gserviceaccount.com`;
    accounts.set(account, { account, sources: ["deploy.json"] });
  }
  for (const account of serviceAccounts) {
    if (!COMPILER_ACCOUNT.test(account)) continue;
    const known = accounts.get(account);
    if (known) known.sources.push("iam");
    else accounts.set(account, { account, sources: ["iam"] });
  }
  return [...accounts.values()].sort((a, b) => a.account.localeCompare(b.account));
}

const fullAccount = subject => (String(subject).includes("@") ? String(subject) : `${subject}@graffiticode.iam.gserviceaccount.com`);

// What a run's config leaves out of the inventory: every compiler account must be probed or
// excluded with a stated reason, and nothing may be probed or excluded that isn't a compiler.
export function inventoryProblems(config, inventory) {
  const probed = new Set((config.compilers ?? []).map(c => fullAccount(c.subject)));
  const excluded = new Map((config.excluded ?? []).map(e => [fullAccount(e.subject), e.reason]));
  const known = new Set(inventory.map(i => i.account));
  const problems = [];
  for (const { account } of inventory) {
    if (!probed.has(account) && !excluded.has(account)) problems.push(`${account} is neither probed nor excluded`);
  }
  for (const [account, reason] of excluded) {
    if (!(typeof reason === "string" && reason.trim())) problems.push(`${account} is excluded without a reason`);
    if (probed.has(account)) problems.push(`${account} is both probed and excluded`);
  }
  for (const account of [...probed, ...excluded.keys()]) if (!known.has(account)) problems.push(`${account} isn't a compiler account`);
  return problems;
}

// The collect.json compilers entries for an inventory: one net job and one IAM job each.
export const compilerJobs = inventory => inventory.map(({ account }) => {
  const lang = account.split("@")[0].replace(/-run$/, "");
  return { subject: `${lang}-run`, net: `at11-net-${lang}`, iam: `at11-iam-${lang}` };
});

// The jobs a run starts: the control, then each compiler's net and IAM jobs.
export function jobsOf(config) {
  if (!config.control) throw new Error("collect.json needs the control's job");
  if (!config.compilers?.length) throw new Error("collect.json needs at least one compiler");
  return [
    { job: config.control, role: "control" },
    ...config.compilers.flatMap(c => [{ job: c.net, role: "net", subject: c.subject }, { job: c.iam, role: "iam", subject: c.subject }]),
  ];
}

// The one evidence line of an execution, from its log entries. It must carry this run's nonce.
export function evidenceFrom(entries, nonce) {
  const lines = entries.map(e => e.textPayload ?? "").filter(t => t.startsWith(EVIDENCE));
  if (!lines.length) return { error: "no AT11-EVIDENCE line" };
  if (lines.length > 1) return { error: `${lines.length} AT11-EVIDENCE lines` };
  let evidence;
  try { evidence = JSON.parse(lines[0].slice(EVIDENCE.length)); } catch { return { error: "the evidence line isn't JSON" }; }
  if (evidence.nonce !== nonce) return { error: `the evidence carries nonce ${evidence.nonce}, not ${nonce}`, refused: true };
  return { evidence };
}

const probesOf = net => net.rows.flatMap(r => (r.results ?? []).flatMap(x => [x.observation?.probe, ...(x.observation?.hops ?? []).map(h => h.observation?.probe)])).filter(Boolean);

// Judges one compiler: its net run settled by the logs and the DNS row by the authoritative log;
// its IAM run combined with the control's.
export function judgeCompiler({ net, iam, control, digests, logs, dnsLog, dnsControl, blocked }) {
  if (!net) return { passed: false, void: true, why: "no net evidence" };
  if (!iam) return { passed: false, void: true, why: "no IAM evidence" };
  const settled = settleNetwork(net, { ...logs, blocked });
  const rows = settled.rows.map(row => {
    if (row.id !== "dns-exfil" || row.state === "n/a") return row;
    const dnsVerdict = judgeDnsRow(row, dnsLog, dnsControl);
    return { ...row, state: dnsVerdict.state, dns: dnsVerdict };
  });
  const netVerdict = verdictOf(rows);
  const iamVerdict = control ? combine(iam, control, { digests }) : { void: true, passed: false, why: "no control run" };
  return {
    passed: netVerdict === "passed" && iamVerdict.passed && !iamVerdict.void,
    void: iamVerdict.void,
    net: { verdict: netVerdict, rows },
    iam: iamVerdict,
  };
}

// The whole run. Every cloud and log call goes through `deps`, so tests drive it with
// recorded output.
export async function collect(config, deps) {
  const { runJob, describeExecution, readLogs, resolveOutside, readDnsLog, inventory, now = () => new Date().toISOString(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), nonce = randomBytes(8).toString("hex") } = deps;
  const attempts = config.retries?.attempts ?? 6;
  const waitMs = config.retries?.waitMs ?? 30000;
  const startedAt = now();

  // 0. Every compiler account, before any job starts.
  if (typeof inventory !== "function") throw new Error("the collector needs the compiler inventory");
  const accounts = await inventory();
  const gaps = inventoryProblems(config, accounts);
  if (gaps.length) return { nonce, passed: false, void: true, why: `the run doesn't cover every compiler account: ${gaps.join("; ")}`, inventory: accounts.length };

  // 1–2. Start every job with the nonce; wait; one digest for all.
  const jobs = jobsOf(config);
  for (const j of jobs) j.execution = (await runJob(j.job, { AT11_NONCE: nonce }))?.execution ?? null;
  const missing = jobs.filter(j => !j.execution).map(j => j.job);
  if (missing.length) return { nonce, passed: false, void: true, why: `no execution for: ${missing.join(", ")}`, jobs };
  const digests = {};
  for (const j of jobs) {
    const d = await describeExecution(j.execution);
    if (!d?.completed) return { nonce, passed: false, void: true, why: `execution ${j.execution} didn't complete`, jobs };
    digests[j.execution] = d.digest;
    j.digest = d.digest;
  }
  const distinct = [...new Set(Object.values(digests))];
  if (distinct.length !== 1 || !distinct[0]) return { nonce, passed: false, void: true, why: `the jobs ran ${distinct.length} image digests`, jobs };

  // 3. Each job's evidence, by execution and nonce.
  for (const j of jobs) {
    const got = evidenceFrom(await readLogs({ kind: "evidence", execution: j.execution }), nonce);
    if (got.refused) return { nonce, passed: false, void: true, why: `${j.job}: ${got.error}`, jobs };
    j.evidence = got.evidence ?? null;
    j.evidenceError = got.error ?? null;
    if (j.evidence && j.evidence.execution && j.evidence.execution !== j.execution) {
      return { nonce, passed: false, void: true, why: `${j.job}: its evidence names execution ${j.evidence.execution}, not ${j.execution}`, jobs };
    }
  }
  const control = jobs.find(j => j.role === "control").evidence;
  if (!control) return { nonce, passed: false, void: true, why: "no control evidence, so every compiler run is void", jobs };

  // 4. The outside DNS control goes first, so the log fetched next can hold it.
  const dnsControl = config.dnsExfil ? { label: `at11-ctl-${randomBytes(8).toString("hex")}`, sentAt: null } : null;
  if (dnsControl) {
    dnsControl.name = `${dnsControl.label}.${config.dnsExfil}`;
    dnsControl.sentAt = now();
    await resolveOutside(dnsControl.name).catch(() => {});
  }

  // 5. Wait for delivery; fetch the logs for the run's window; retry until the control is in.
  const nets = jobs.filter(j => j.role === "net" && j.evidence);
  const probes = nets.flatMap(j => probesOf(j.evidence));
  const queried = nets.flatMap(j => (j.evidence.rows.find(r => r.id === "dns-exfil")?.results ?? []).map(r => r.logCheck?.queriedAt)).filter(Boolean).sort();
  const from = queried[0] ?? startedAt;
  let logs, dnsLog;
  for (let i = 0; i < attempts; i++) {
    await sleep(waitMs);
    const to = now();
    logs = {
      accessLines: await readLogs({ kind: "access", probes, from: startedAt, to }),
      kernelLines: (await readLogs({ kind: "kernel", from: startedAt, to })).map(kernelText),
      firewallHits: (await readLogs({ kind: "firewall", from: startedAt, to })).map(e => e.jsonPayload ?? e),
    };
    dnsLog = dnsControl ? await readDnsLog({ from, to }) : null;
    if (!dnsControl || dnsLog?.text?.includes(dnsControl.label)) break;
  }

  // 6. Judge, per compiler, and together.
  const subjects = config.compilers.map(c => {
    const net = jobs.find(j => j.role === "net" && j.subject === c.subject);
    const iam = jobs.find(j => j.role === "iam" && j.subject === c.subject);
    return {
      subject: c.subject,
      executions: { net: net.execution, iam: iam.execution, control: jobs[0].execution },
      ...(net.evidenceError || iam.evidenceError ? { evidenceErrors: [net.evidenceError, iam.evidenceError].filter(Boolean) } : {}),
      ...judgeCompiler({ net: net.evidence, iam: iam.evidence, control, digests, logs, dnsLog, dnsControl, blocked: config.blocked }),
    };
  });
  return {
    nonce,
    at: now(),
    digest: distinct[0],
    dnsControl,
    passed: subjects.every(s => s.passed),
    void: subjects.some(s => s.void),
    inventory: accounts.length,
    excluded: config.excluded ?? [],
    subjects,
    jobs: jobs.map(({ evidence, ...j }) => j),
  };
}

// Writes the run's evidence: the summary, and each job's evidence, under .gc-deploy/at11/<nonce>/.
export async function writeRun(outDir, result, jobs = []) {
  if (!/^[0-9a-f]+$/.test(result.nonce)) throw new Error(`not a nonce: ${result.nonce}`);
  const dir = path.join(outDir ?? path.join(ROOT, ".gc-deploy", "at11"), result.nonce);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "summary.json"), JSON.stringify(result, null, 2) + "\n");
  for (const j of jobs) if (j.evidence) await writeFile(path.join(dir, `${j.job}.json`), JSON.stringify(j.evidence, null, 2) + "\n");
  return dir;
}

// --- the operator's gcloud, for a real run ---

const run = promisify(execFile);
const gcloud = async (args) => JSON.parse((await run("gcloud", [...args, "--format=json"], { maxBuffer: 64 * 1024 * 1024 })).stdout || "null");

export function gcloudDeps(config) {
  const p = `--project=${config.project}`;
  const r = `--region=${config.region}`;
  const read = async (filter) => (await gcloud(["logging", "read", filter, p, "--limit=10000", "--order=asc"])) ?? [];
  const window = (from, to) => `timestamp>="${from}" AND timestamp<="${to}"`;
  return {
    // Read-only: deploy.json and the project's service accounts.
    inventory: async () => compilerInventory({
      deployServices: JSON.parse(await readFile(path.join(ROOT, "deploy.json"), "utf8")).services,
      serviceAccounts: ((await gcloud(["iam", "service-accounts", "list", p])) ?? []).map(a => a.email),
    }),
    runJob: async (job, env) => {
      const op = await gcloud(["run", "jobs", "execute", job, p, r, "--async", `--update-env-vars=${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(",")}`]);
      return { execution: op?.metadata?.name?.split("/").pop() ?? op?.name?.split("/").pop() ?? null };
    },
    describeExecution: async (execution) => {
      for (let i = 0; i < 120; i++) {
        const e = await gcloud(["run", "jobs", "executions", "describe", execution, p, r]);
        const done = (e?.status?.conditions ?? []).find(c => c.type === "Completed");
        if (done && done.status !== "Unknown") return { completed: true, digest: e.spec?.template?.spec?.containers?.[0]?.image?.split("@")[1] ?? null };
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
      return { completed: false };
    },
    readLogs: async ({ kind, execution, probes, from, to }) => {
      if (kind === "evidence") return read(`resource.type="cloud_run_job" AND labels."run.googleapis.com/execution_name"="${execution}" AND textPayload:"${EVIDENCE.trim()}"`);
      if (kind === "access") {
        if (!probes.length) return [];
        const lines = (await read(`jsonPayload.isolate01:* AND ${window(from, to)}`)).map(e => e.jsonPayload);
        const wanted = new Set(probes);
        return lines.filter(l => wanted.has(l.probe));
      }
      // COS ships kernel lines from the journal as jsonPayload.MESSAGE (cos_journal_warning),
      // not textPayload (step 0).
      if (kind === "kernel") return read(`(jsonPayload.MESSAGE:"ISOLATE01-REJECT" OR textPayload:"ISOLATE01-REJECT") AND ${window(from, to)}`);
      if (kind === "firewall") return read(`logName:"compute.googleapis.com%2Ffirewall" AND jsonPayload.disposition="DENIED" AND ${window(from, to)}`);
      throw new Error(`unknown log kind ${kind}`);
    },
    resolveOutside: name => dns.resolve4(name),
    readDnsLog: async ({ from, to }) => {
      const entries = await read(`${config.dnsLog.filter} AND ${window(from, to)}`);
      return { text: entries.map(e => JSON.stringify(e.jsonPayload ?? e.textPayload ?? "")).join("\n"), from, to, fetchedAt: new Date().toISOString() };
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ["--config", "--out"]);
  if (!args["--config"]) throw new Error("usage: collect.js --config collect.json [--out dir]");
  const config = JSON.parse(await readFile(args["--config"], "utf8"));
  const deps = gcloudDeps(config);
  const evidence = [];
  const readLogs = deps.readLogs;
  // Keep each job's evidence for the run's directory.
  deps.readLogs = async q => {
    const entries = await readLogs(q);
    if (q.kind === "evidence") evidence.push({ execution: q.execution, entries });
    return entries;
  };
  const result = await collect(config, deps);
  const jobs = (result.jobs ?? []).map(j => ({ ...j, evidence: evidenceFrom(evidence.find(e => e.execution === j.execution)?.entries ?? [], result.nonce).evidence }));
  const dir = await writeRun(args["--out"], result, jobs);
  for (const s of result.subjects ?? []) console.log(`${s.passed ? "PASSED" : s.void ? "VOID  " : "FAILED"} ${s.subject}${s.iam?.why ? ` — ${s.iam.why}` : ""}`);
  console.log(`${result.passed ? "PASSED" : result.void ? "VOID" : "FAILED"}${result.why ? ` — ${result.why}` : ""}; evidence: ${dir}`);
  process.exit(result.passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
