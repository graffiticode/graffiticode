import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collect, evidenceFrom, jobsOf, writeRun, kernelText, compilerInventory, inventoryProblems, compilerJobs } from "../at11/collect.js";
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
  probe: "net",
  nonce,
  execution,
  kind: "default",
  verdict: "pending",
  passed: false,
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
  const executions = { "at11-iam-control": "at11-iam-control-x1", "at11-net-l0176": "at11-net-l0176-x2", "at11-iam-l0176": "at11-iam-l0176-x3", ...overrides.executions };
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
    // The one compiler this config probes is the whole inventory, unless a test says otherwise.
    inventory: async () => overrides.inventory ?? [{ account: "l0176-run@graffiticode.iam.gserviceaccount.com", sources: ["deploy.json", "iam"] }],
    now,
    sleep: async () => {},
    runJob: async (job, env, project) => { calls.push(`run ${job} ${env.AT11_NONCE}${project ? ` in ${project}` : ""}`); return overrides.runJob ? overrides.runJob(job) : { execution: executions[job] }; },
    describeExecution: async (execution, project) => { calls.push(`describe ${execution}${project ? ` in ${project}` : ""}`); return { completed: true, digest: overrides.digests?.[execution] ?? "sha256:one" }; },
    readLogs: async q => {
      calls.push(`logs ${q.kind}${q.project ? ` in ${q.project}` : ""}`);
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

test("a control job in another project is started, described and read there; the compilers stay in the config's project", async () => {
  const { deps, calls } = fakeDeps();
  const result = await collect({ ...config, controlProject: "graffiticode-isolate01" }, deps);
  assert.equal(result.passed, true, JSON.stringify(result, null, 2));
  assert.ok(calls.includes(`run at11-iam-control ${NONCE} in graffiticode-isolate01`), calls.join("\n"));
  assert.ok(calls.includes("describe at11-iam-control-x1 in graffiticode-isolate01"));
  assert.ok(calls.includes("logs evidence in graffiticode-isolate01"));
  assert.ok(calls.includes(`run at11-net-l0176 ${NONCE}`) && calls.includes(`run at11-iam-l0176 ${NONCE}`));
  assert.equal(calls.filter(c => c.endsWith("in graffiticode-isolate01")).length, 3);
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

test("kernel lines are read from COS's journal entries (jsonPayload.MESSAGE), as step 0 found them", () => {
  const entry = { logName: "projects/p/logs/cos_journal_warning", jsonPayload: { MESSAGE: "ISOLATE01-REJECT metadata IN= OUT=eth0 SRC=10.8.0.4 DST=169.254.169.254 LEN=60 PROTO=TCP SPT=52256 DPT=443" } };
  assert.match(kernelText(entry), /DST=169\.254\.169\.254/);
  assert.equal(kernelText({ textPayload: "ISOLATE01-REJECT lb DST=10.8.0.2" }), "ISOLATE01-REJECT lb DST=10.8.0.2");
});

// Step 7: every compiler account, not only deploy.json's.
test("the inventory is deploy.json's languages and every compiler account in the project", () => {
  const inventory = compilerInventory({
    deployServices: { api: { runtimeServiceAccount: "api-run@graffiticode.iam.gserviceaccount.com" }, l0176: { runtimeServiceAccount: "l0176-run@graffiticode.iam.gserviceaccount.com" }, l0176r: {} },
    serviceAccounts: ["l0176-run@graffiticode.iam.gserviceaccount.com", "l0158-run@graffiticode.iam.gserviceaccount.com", "policy-run@graffiticode.iam.gserviceaccount.com", "l0002-run@graffiticode.iam.gserviceaccount.com", "l0176-run@other.iam.gserviceaccount.com"],
  });
  assert.deepEqual(inventory.map(i => [i.account.split("@")[0], i.sources.join("+")]), [
    ["l0002-run", "iam"], ["l0158-run", "iam"], ["l0176-run", "deploy.json+iam"], ["l0176r-run", "deploy.json"],
  ]);
  // A legacy compiler (outside deploy.json) gets an IAM job and the D6 network exception; the rest get both jobs.
  assert.deepEqual(compilerJobs(inventory.slice(0, 1)), [{ subject: "l0002-run", iam: "at11-iam-l0002", exception: "D6" }]);
  assert.deepEqual(compilerJobs(inventory.slice(2, 3)), [{ subject: "l0176-run", net: "at11-net-l0176", iam: "at11-iam-l0176" }]);
});

test("a run must probe or exclude, with a reason, every compiler account, and nothing else", () => {
  const inventory = [{ account: "l0002-run@graffiticode.iam.gserviceaccount.com", sources: ["iam"] }, { account: "l0176-run@graffiticode.iam.gserviceaccount.com", sources: ["deploy.json", "iam"] }];
  const l0176 = { subject: "l0176-run", net: "at11-net-l0176", iam: "at11-iam-l0176" };
  const l0002 = { subject: "l0002-run", iam: "at11-iam-l0002", exception: "D6" };
  assert.deepEqual(inventoryProblems({ compilers: [l0176] }, inventory), ["l0002-run@graffiticode.iam.gserviceaccount.com is neither probed nor excluded"]);
  assert.deepEqual(inventoryProblems({ compilers: [l0176], excluded: [{ subject: "l0002-run", reason: "no service deployed (2026-10-19)" }] }, inventory), []);
  assert.match(inventoryProblems({ compilers: [l0176], excluded: [{ subject: "l0002-run", reason: " " }] }, inventory).join(), /without a reason/);
  assert.match(inventoryProblems({ compilers: [l0176, l0002], excluded: [{ subject: "l0002-run", reason: "x" }] }, inventory).join(), /both probed and excluded/);
  assert.match(inventoryProblems({ compilers: [l0176, l0002, { subject: "api-run", iam: "at11-iam-api", net: "at11-net-api" }] }, inventory).join(), /api-run.* isn't a compiler account/);
  // D6: a legacy compiler may skip its net job; a deploy.json compiler may not; every one needs an IAM job.
  assert.deepEqual(inventoryProblems({ compilers: [l0176, l0002] }, inventory), []);
  assert.match(inventoryProblems({ compilers: [{ ...l0176, net: undefined, exception: "D6" }, l0002] }, inventory).join(), /l0176-run.* is in deploy.json, so D6 doesn't cover it/);
  assert.match(inventoryProblems({ compilers: [l0176, { ...l0002, exception: undefined }] }, inventory).join(), /no net job and no recorded exception/);
  assert.match(inventoryProblems({ compilers: [l0176, { ...l0002, exception: "D9" }] }, inventory).join(), /no net job and no recorded exception/);
  assert.match(inventoryProblems({ compilers: [{ ...l0176, iam: undefined }, l0002] }, inventory).join(), /l0176-run.* has no IAM job/);
});

test("a run that leaves a compiler account out is void before any job starts", async () => {
  const { deps, calls } = fakeDeps({ inventory: [{ account: "l0176-run@graffiticode.iam.gserviceaccount.com" }, { account: "l0158-run@graffiticode.iam.gserviceaccount.com" }] });
  const result = await collect(config, deps);
  assert.equal(result.void, true);
  assert.match(result.why, /l0158-run.*neither probed nor excluded/);
  assert.deepEqual(calls, []);
  await assert.rejects(collect(config, { ...deps, inventory: undefined }), /compiler inventory/);
});

test("a D6 compiler is judged by its IAM probe beside the control, with no network verdict", async () => {
  const d6 = { ...config, compilers: [...config.compilers, { subject: "l0002-run", iam: "at11-iam-l0002", exception: "D6" }] };
  const { deps, calls } = fakeDeps({
    inventory: [{ account: "l0176-run@graffiticode.iam.gserviceaccount.com", sources: ["deploy.json"] }, { account: "l0002-run@graffiticode.iam.gserviceaccount.com", sources: ["iam"] }],
    executions: { "at11-iam-l0002": "at11-iam-l0002-x4" },
    evidence: { "at11-iam-l0002-x4": iamCompiler("at11-iam-l0002-x4") },
  });
  const result = await collect(d6, deps);
  assert.ok(!calls.some(c => c.startsWith("run at11-net-l0002")), "no net job runs for a D6 compiler");
  assert.ok(calls.some(c => c.startsWith("run at11-iam-l0002")));
  const legacy = result.subjects.find(s => s.subject === "l0002-run");
  assert.equal(legacy.exception, "D6");
  assert.equal(legacy.net.verdict, "exception D6");
  assert.equal(legacy.executions.net, null);
  assert.equal(legacy.passed, true);
  assert.equal(result.passed, true);
});

// The committed step 7 configs (deploy/egress-proxy/step7/at11).
test("the step 7 config probes every compiler account: deploy.json's with net and IAM jobs, the 26 legacy ones IAM-only under D6", async () => {
  const { readFile } = await import("node:fs/promises");
  const { step7Config } = await import("../at11/step7-config.js");
  const committed = JSON.parse(await readFile(new URL("../../deploy/egress-proxy/step7/at11/collect.json", import.meta.url), "utf8"));
  const deployServices = JSON.parse(await readFile(new URL("../../deploy.json", import.meta.url), "utf8")).services;
  const languages = Object.keys(deployServices).filter(n => /^l\d{4}r?$/.test(n));
  const legacy = committed.compilers.filter(c => c.exception === "D6");
  assert.equal(legacy.length, 26);
  assert.ok(legacy.every(c => !c.net && c.iam === `at11-iam-${c.subject.replace(/-run$/, "")}` && !languages.includes(c.subject.replace(/-run$/, ""))));
  assert.deepEqual(committed.excluded, []);
  for (const lang of languages) assert.ok(committed.compilers.some(c => c.subject === `${lang}-run` && c.net && c.iam), `${lang} has net and IAM jobs`);
  // Regenerating from the same inventory gives the committed file.
  const inventory = compilerInventory({ deployServices, serviceAccounts: legacy.map(c => `${c.subject}@graffiticode.iam.gserviceaccount.com`) });
  assert.deepEqual(step7Config(inventory).compilers, committed.compilers);
});

test("long evidence goes out in parts under the log-line limit, and comes back whole (2026-10-20)", async () => {
  const { evidenceLines, EVIDENCE_PART_MAX } = await import("../at11/lib.js");
  const result = { probe: "net", nonce: NONCE, rows: Array.from({ length: 2000 }, (_, i) => ({ id: `row-${i}`, note: "é ünïcode ✓", pad: "x".repeat(60) })) };
  const lines = evidenceLines(result);
  assert.ok(lines.length > 1);
  for (const l of lines) {
    assert.match(l, /^AT11-EVIDENCE-PART \d+\/\d+ /);
    assert.ok(Buffer.byteLength(l) < 64 * 1024 && Buffer.byteLength(l) <= EVIDENCE_PART_MAX + 40, `a ${Buffer.byteLength(l)}-byte line`);
  }
  const entries = lines.map(textPayload => ({ textPayload }));
  // Log order isn't guaranteed: the parts are reassembled by index.
  assert.deepEqual(evidenceFrom([...entries].reverse(), NONCE).evidence, result);
  assert.deepEqual(evidenceFrom(evidenceLines({ nonce: NONCE, small: true }).map(textPayload => ({ textPayload })), NONCE).evidence, { nonce: NONCE, small: true });
});

test("incomplete, repeated or mixed evidence parts are refused", async () => {
  const { evidenceLines } = await import("../at11/lib.js");
  const lines = evidenceLines({ nonce: NONCE, pad: "y".repeat(150000) });
  const e = ls => ls.map(textPayload => ({ textPayload }));
  assert.equal(lines.length, 3);
  assert.match(evidenceFrom(e(lines.slice(1)), NONCE).error, /PART 1\/3 is missing/);
  assert.match(evidenceFrom(e([...lines, lines[0]]), NONCE).error, /twice/);
  assert.match(evidenceFrom(e([...lines.slice(0, 2), lines[2].replace(" 3/3 ", " 3/4 ")]), NONCE).error, /different sets/);
  assert.match(evidenceFrom(e([...lines, `AT11-EVIDENCE {"nonce":"${NONCE}"}`]), NONCE).error, /both/);
});

test("the D6 config probes the legacy compilers and excludes the rest with a reason", async () => {
  const { d6Config } = await import("../at11/step7-config.js");
  const inventory = [
    { account: "l0176-run@graffiticode.iam.gserviceaccount.com", sources: ["deploy.json", "iam"] },
    { account: "l0002-run@graffiticode.iam.gserviceaccount.com", sources: ["iam"] },
  ];
  const config = d6Config(inventory, new Set(["l0002"]), "b492fffa1316be33");
  assert.deepEqual(config.compilers, [{ subject: "l0002-run", net: "at11-net-l0002", iam: "at11-iam-l0002" }]);
  assert.deepEqual(config.excluded, [{ subject: "l0176-run", reason: "passed AT-11 run b492fffa1316be33 (2026-10-20)" }]);
  assert.deepEqual(inventoryProblems(config, inventory), []);
});
