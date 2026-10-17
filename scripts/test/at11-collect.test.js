import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collect, evidenceFrom, jobsOf, writeRun } from "../at11/collect.js";
import { VERSION } from "../at11/iam.js";

const NONCE = "00aa11bb22cc33dd";
const config = {
  project: "graffiticode",
  region: "us-central1",
  control: "at11-iam-control",
  compilers: [{ subject: "l0176-run", net: "at11-net-l0176", iam: "at11-iam-l0176" }],
  dnsExfil: "exfil.example",
  blocked: { compilerSubnets: ["10.20.0.0/20"], proxySubnet: "10.8.0.0/28", loadBalancer: "10.8.0.2" },
  retries: { attempts: 3, waitMs: 0 },
};

const netEvidence = (execution, nonce = NONCE) => ({
  probe: "net", nonce, execution, kind: "default", verdict: "pending", passed: false,
  rows: [
    { id: "listed", expected: "succeeds", state: "passed", results: [{ target: "auth.graffiticode.org", observation: { probe: `${nonce}-1-aa` }, result: { outcome: "succeeds", status: 200 } }] },
    { id: "unlisted", expected: "refused:proxy/unlisted", state: "passed", results: [{ target: "example.com", observation: { probe: `${nonce}-2-bb`, stage: "connect", status: 403 }, result: { outcome: "refused:proxy", reason: "unlisted" } }] },
    { id: "dns-exfil", expected: "nxdomain", state: "pending-log", results: [{ target: "at11-aaa.exfil.example", observation: { error: "nxdomain" }, result: { outcome: "nxdomain" }, logCheck: { label: "at11-aaa", queriedAt: "2026-10-17T10:00:00.000Z" } }] },
  ],
});
const iamCompiler = (execution, nonce = NONCE) => ({ probe: "iam", role: "compiler", version: VERSION, nonce, execution, passed: true, rows: [{ id: "coverage", kind: "coverage", passed: true }, { id: "secret access s", kind: "secret access", passed: true }] });
const iamControl = (execution, nonce = NONCE) => ({ probe: "iam", role: "control", version: VERSION, nonce, execution, passed: true, rows: [{ id: "secret access canary", kind: "secret access", passed: true }] });

const line = evidence => [{ textPayload: `AT11-EVIDENCE ${JSON.stringify(evidence)}` }];

// A fake operator environment: jobs, executions and logs, with every call recorded in order.
function fakeDeps(overrides = {}) {
  const calls = [];
  let clock = Date.parse("2026-10-17T10:01:00.000Z");
  const now = () => new Date(clock += 1000).toISOString();
  const executions = { "at11-iam-control": "at11-iam-control-x1", "at11-net-l0176": "at11-net-l0176-x2", "at11-iam-l0176": "at11-iam-l0176-x3" };
  const evidence = {
    "at11-iam-control-x1": iamControl("at11-iam-control-x1"),
    "at11-net-l0176-x2": netEvidence("at11-net-l0176-x2"),
    "at11-iam-l0176-x3": iamCompiler("at11-iam-l0176-x3"),
    ...overrides.evidence,
  };
  let control = null;
  const dnsLogs = overrides.dnsLogs ?? [label => ({ text: `query: ${label}.exfil.example IN A\n`, fetchedAt: now() })];
  let dnsCall = 0;
  const deps = {
    nonce: NONCE,
    now,
    sleep: async () => {},
    runJob: async (job, env) => { calls.push(`run ${job} ${env.AT11_NONCE}`); return overrides.runJob ? overrides.runJob(job) : { execution: executions[job] }; },
    describeExecution: async execution => { calls.push(`describe ${execution}`); return { completed: true, digest: overrides.digests?.[execution] ?? "sha256:one" }; },
    readLogs: async q => {
      calls.push(`logs ${q.kind}`);
      if (q.kind === "evidence") return evidence[q.execution] ? line(evidence[q.execution]) : [];
      if (q.kind === "access") return overrides.accessLines ?? [{ isolate01: "egress", probe: `${NONCE}-2-bb`, decision: "refuse", reason: "unlisted" }];
      return [];
    },
    resolveOutside: async name => { calls.push(`control ${name}`); control = name.split(".")[0]; throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); },
    readDnsLog: async ({ from, to }) => {
      calls.push("dns log");
      const make = dnsLogs[Math.min(dnsCall++, dnsLogs.length - 1)];
      return { from, to, ...make(control) };
    },
  };
  return { deps, calls };
}

test("a run starts every identity-bound job with one nonce, and judges them together", async () => {
  const { deps, calls } = fakeDeps();
  const result = await collect(config, deps);
  assert.equal(result.passed, true, JSON.stringify(result, null, 2));
  assert.equal(result.void, false);
  assert.deepEqual(jobsOf(config).map(j => j.job), ["at11-iam-control", "at11-net-l0176", "at11-iam-l0176"]);
  assert.deepEqual(calls.filter(c => c.startsWith("run ")), [`run at11-iam-control ${NONCE}`, `run at11-net-l0176 ${NONCE}`, `run at11-iam-l0176 ${NONCE}`]);
  const [s] = result.subjects;
  assert.deepEqual(s.executions, { net: "at11-net-l0176-x2", iam: "at11-iam-l0176-x3", control: "at11-iam-control-x1" });
  assert.equal(s.net.rows.find(r => r.id === "dns-exfil").state, "passed");
  assert.equal(result.digest, "sha256:one");
});

test("the DNS control is sent before the log is fetched (A24)", async () => {
  const { deps, calls } = fakeDeps();
  await collect(config, deps);
  const control = calls.findIndex(c => c.startsWith("control "));
  const log = calls.indexOf("dns log");
  assert.ok(control >= 0 && log > control, calls.join("\n"));
  assert.ok(calls.indexOf("logs access") > control, "the other logs are fetched after the control too");
});

test("a log fetched before the control can't satisfy the DNS row (A24)", async () => {
  // A cached or stale log, fetched before the control went out.
  const { deps } = fakeDeps({ dnsLogs: [label => ({ text: `query: ${label}.exfil.example\n`, fetchedAt: "2026-10-17T10:00:30.000Z" })] });
  const result = await collect(config, deps);
  assert.equal(result.passed, false);
  assert.equal(result.subjects[0].net.rows.find(r => r.id === "dns-exfil").state, "void");
});

test("a pending-log row without the log fails (A17)", async () => {
  const { deps } = fakeDeps({ dnsLogs: [() => ({ text: "", fetchedAt: "2026-10-17T11:00:00.000Z" })] });
  const result = await collect(config, deps);
  assert.equal(result.passed, false);
  const dnsRow = result.subjects[0].net.rows.find(r => r.id === "dns-exfil");
  assert.equal(dnsRow.state, "void");
  assert.match(dnsRow.dns.why, /empty/);
});

test("the log is fetched again until the control label arrives, a bounded number of times", async () => {
  const late = fakeDeps({ dnsLogs: [() => ({ text: "query: other.exfil.example\n", fetchedAt: "2026-10-17T11:00:00.000Z" }), label => ({ text: `query: ${label}.exfil.example\n`, fetchedAt: "2026-10-17T11:01:00.000Z" })] });
  const ok = await collect(config, late.deps);
  assert.equal(ok.passed, true);
  assert.equal(late.calls.filter(c => c === "dns log").length, 2);
  const never = fakeDeps({ dnsLogs: [() => ({ text: "query: other.exfil.example\n", fetchedAt: "2026-10-17T11:00:00.000Z" })] });
  const failed = await collect(config, never.deps);
  assert.equal(failed.passed, false);
  assert.equal(never.calls.filter(c => c === "dns log").length, config.retries.attempts);
});

test("a missing control execution voids the run", async () => {
  const { deps } = fakeDeps({ runJob: job => (job === "at11-iam-control" ? null : { execution: `${job}-x` }) });
  const result = await collect(config, deps);
  assert.equal(result.passed, false);
  assert.equal(result.void, true);
  assert.match(result.why, /no execution for: at11-iam-control/);
  // So does a control whose evidence never arrived.
  const noEvidence = fakeDeps({ evidence: { "at11-iam-control-x1": undefined } });
  const r2 = await collect(config, noEvidence.deps);
  assert.equal(r2.void, true);
  assert.match(r2.why, /no control evidence/);
});

test("evidence from another run's nonce is refused", async () => {
  const { deps } = fakeDeps({ evidence: { "at11-iam-l0176-x3": iamCompiler("at11-iam-l0176-x3", "ffffffffffffffff") } });
  const result = await collect(config, deps);
  assert.equal(result.passed, false);
  assert.equal(result.void, true);
  assert.match(result.why, /nonce/);
  assert.deepEqual(evidenceFrom([{ textPayload: "AT11-EVIDENCE {\"nonce\":\"a\"}" }], "b").refused, true);
  assert.match(evidenceFrom([], "b").error, /no AT11-EVIDENCE/);
  assert.match(evidenceFrom([...line({ nonce: "b" }), ...line({ nonce: "b" })], "b").error, /2 AT11-EVIDENCE lines/);
});

test("mixed image digests are refused", async () => {
  const { deps } = fakeDeps({ digests: { "at11-net-l0176-x2": "sha256:two" } });
  const result = await collect(config, deps);
  assert.equal(result.passed, false);
  assert.equal(result.void, true);
  assert.match(result.why, /2 image digests/);
});

test("a proxy refusal without its log line fails, even though the job saw the header (A4)", async () => {
  const { deps } = fakeDeps({ accessLines: [] });
  const result = await collect(config, deps);
  assert.equal(result.passed, false);
  const row = result.subjects[0].net.rows.find(r => r.id === "unlisted");
  assert.equal(row.state, "failed");
  assert.match(row.results[0].result.detail, /no proxy access line/);
  const other = fakeDeps({ accessLines: [{ isolate01: "egress", probe: `${NONCE}-2-bb`, decision: "refuse", reason: "port" }] });
  assert.equal((await collect(config, other.deps)).subjects[0].net.rows.find(r => r.id === "unlisted").state, "failed", "another reason");
});

test("the run's evidence is written under its nonce", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "at11-collect-"));
  try {
    const { deps } = fakeDeps();
    const result = await collect(config, deps);
    const out = await writeRun(dir, result, [{ job: "at11-net-l0176", evidence: netEvidence("at11-net-l0176-x2") }]);
    assert.equal(out, path.join(dir, NONCE));
    assert.equal(JSON.parse(readFileSync(path.join(out, "summary.json"), "utf8")).passed, true);
    assert.equal(JSON.parse(readFileSync(path.join(out, "at11-net-l0176.json"), "utf8")).execution, "at11-net-l0176-x2");
    await assert.rejects(writeRun(dir, { nonce: "../x" }), /not a nonce/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
