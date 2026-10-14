import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { MATRIX, classify, meets, runNet, connectTunnel, checkDnsLog } from "../at11/net.js";
import { checksFor, judgeDenied, judgeAllowed, runIam, combine, VERSION } from "../at11/iam.js";
import { SERVER_CASES, BROWSER_CASES, judgeDataApi, runServer, judgeBrowser, harness, signedBrowserCases } from "../at11/d1.js";

// --- the network probe ---

test("the matrix has an expectation for every class kind, and every row a check", async () => {
  const { CHECKS } = await import("../at11/net.js");
  for (const row of MATRIX) {
    for (const kind of ["default", "lang", "open"]) assert.ok(row[kind], `${row.id} ${kind}`);
    assert.equal(typeof CHECKS[row.id], "function", row.id);
  }
});

test("a refusal is identified by the control that made it, never just a failure", () => {
  assert.deepEqual(classify({ via: "proxy", stage: "connect", status: 403, headers: { "x-isolate01-refused": "unlisted" } }), { outcome: "refused:proxy", reason: "unlisted" });
  assert.deepEqual(classify({ via: "proxy", stage: "request", status: 403, headers: { "x-isolate01-refused": "host-mismatch" } }), { outcome: "refused:proxy", reason: "host-mismatch" });
  // A 403 from the destination (Cloud Run IAM) is the destination answering.
  assert.deepEqual(classify({ via: "proxy", stage: "request", status: 403, headers: {} }), { outcome: "succeeds", status: 403 });
  assert.deepEqual(classify({ via: "proxy", stage: "connect", status: 503, headers: {} }), { outcome: "refused:network", status: 503 });
  assert.equal(classify({ via: "proxy", stage: "connect", status: 407, headers: {} }).outcome, "error");
  assert.deepEqual(classify({ via: "direct", error: "timeout" }), { outcome: "refused:firewall" });
  assert.deepEqual(classify({ via: "direct", error: "nxdomain" }), { outcome: "nxdomain" });
  assert.equal(classify({ via: "direct", error: "EPROTO weird" }).outcome, "error");
});

test("expectations are met only by the named outcome and reason", () => {
  assert.ok(meets("refused:proxy/unlisted", { outcome: "refused:proxy", reason: "unlisted" }));
  assert.ok(!meets("refused:proxy/unlisted", { outcome: "refused:proxy", reason: "name" }));
  assert.ok(!meets("refused:proxy/unlisted", { outcome: "refused:network" }));
  assert.ok(meets("refused", { outcome: "refused:firewall" }));
  assert.ok(!meets("refused", { outcome: "succeeds", status: 200 }));
  assert.ok(meets("status:401", { outcome: "succeeds", status: 401 }));
  assert.ok(!meets("status:401", { outcome: "succeeds", status: 403 }));
  assert.ok(!meets("refused:firewall", { outcome: "error", detail: "x" }), "an unexplained failure never passes");
});

test("a run passes only when every applicable row ran and met its expectation", async () => {
  const fake = (overrides = {}) => Object.fromEntries(MATRIX.map(r => [r.id, async () => overrides[r.id] === undefined ? [{ target: "t", observation: {}, result: expectedResult(r.default) }] : overrides[r.id]]));
  const expectedResult = e => e === "succeeds" ? { outcome: "succeeds", status: 200 } : e === "nxdomain" ? { outcome: "nxdomain" } : e.startsWith("status:") ? { outcome: "succeeds", status: Number(e.slice(7)) } : e === "refused" ? { outcome: "refused:firewall" } : e.includes("/") ? { outcome: e.split("/")[0], reason: e.split("/")[1] } : { outcome: e };
  const config = { kind: "default" };
  const pass = await runNet(config, fake());
  assert.equal(pass.passed, true, JSON.stringify(pass.rows.filter(r => r.state !== "passed" && r.state !== "n/a")));
  const notRun = await runNet(config, fake({ "dns-exfil": null }));
  assert.equal(notRun.passed, false);
  assert.equal(notRun.rows.find(r => r.id === "dns-exfil").state, "not run");
  const failed = await runNet(config, fake({ unlisted: [{ target: "example.com", observation: {}, result: { outcome: "succeeds", status: 200 } }] }));
  assert.equal(failed.passed, false);
  assert.equal(failed.rows.find(r => r.id === "unlisted").state, "failed");
  // For L0185 the relay is a residual: run and recorded, never a failure.
  const open = await runNet({ kind: "open" }, Object.fromEntries(MATRIX.map(r => [r.id, async () => [{ target: "t", observation: {}, result: r.open === "residual" ? { outcome: "succeeds", status: 200 } : expectedResult(r.open) }]])));
  assert.equal(open.rows.find(r => r.id === "relay").state, "residual");
  assert.equal(open.passed, true);
});

test("connectTunnel reads the proxy's status and refusal header", async () => {
  const server = net.createServer(socket => socket.once("data", head => {
    const target = head.toString().split(" ")[1];
    if (target.startsWith("down.")) socket.end("HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n");
    else if (target.startsWith("ok.")) socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    else socket.end("HTTP/1.1 403 Forbidden\r\nX-Isolate01-Refused: unlisted\r\ncontent-length: 0\r\n\r\n");
  }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const proxy = `http://127.0.0.1:${server.address().port}`;
  try {
    const refused = await connectTunnel(proxy, "example.com:443");
    assert.deepEqual(classify(refused), { outcome: "refused:proxy", reason: "unlisted" });
    const down = await connectTunnel(proxy, "down.test:443");
    assert.equal(classify(down).outcome, "refused:network");
    const open = await connectTunnel(proxy, "ok.test:443");
    assert.equal(open.status, 200);
    assert.ok(open.socket);
    open.socket.destroy();
  } finally {
    server.close();
  }
});

test("the DNS exfiltration row is decided by the authoritative server's log", () => {
  const evidence = { rows: [{ id: "dns-exfil", results: [{ target: "at11-abc.x.example", logCheck: { name: "at11-abc.x.example", label: "at11-abc" } }] }] };
  assert.deepEqual(checkDnsLog(evidence, "query: other.x.example A\n"), { checked: true, leaked: [], passed: true });
  assert.equal(checkDnsLog(evidence, "client 34.1.2.3: query: at11-abc.x.example IN A\n").passed, false);
});

// --- the IAM probe ---

const iamConfig = {
  project: "graffiticode",
  secrets: ["projects/graffiticode/secrets/broker-key"],
  databases: ["projects/graffiticode/databases/broker"],
  kmsKeys: ["projects/graffiticode/locations/global/keyRings/policy/cryptoKeys/sign/cryptoKeyVersions/1"],
  impersonate: ["policy-run@graffiticode.iam.gserviceaccount.com"],
  service: "projects/graffiticode/locations/us-central1/services/l0176",
  ownAudience: "https://broker.example",
  canary: {
    project: "graffiticode",
    secrets: ["projects/graffiticode/secrets/at11-canary"],
    databases: ["projects/graffiticode/databases/at11-canary"],
    kmsKeys: ["projects/graffiticode/locations/global/keyRings/at11/cryptoKeys/canary/cryptoKeyVersions/1"],
    impersonate: ["at11-canary@graffiticode.iam.gserviceaccount.com"],
    service: "projects/graffiticode/locations/us-central1/services/at11-canary",
  },
};

test("no IAM check could change anything if it were wrongly allowed", () => {
  for (const c of checksFor(iamConfig)) {
    assert.ok(!/:setIamPolicy$/.test(c.url), `${c.id} calls setIamPolicy`);
    if (c.method === "PATCH" && c.url.includes("run.googleapis.com")) assert.match(c.url, /validateOnly=true/);
    if (c.method === "PATCH" && c.url.includes("firestore")) assert.match(c.url, /currentDocument\.exists=true/);
  }
  assert.ok(checksFor(iamConfig).some(c => c.test && c.body.permissions.includes("resourcemanager.projects.setIamPolicy")));
});

test("only a 403 PERMISSION_DENIED (or an empty grant) counts as a denial", () => {
  const read = { permission: "secretmanager.versions.access" };
  assert.equal(judgeDenied(read, { status: 403, body: { error: { status: "PERMISSION_DENIED", message: "Permission 'secretmanager.versions.access' denied" } } }).passed, true);
  assert.equal(judgeDenied(read, { status: 404, body: { error: { status: "NOT_FOUND" } } }).passed, false);
  assert.equal(judgeDenied(read, { status: 401, body: {} }).passed, false);
  assert.equal(judgeDenied(read, { error: "ECONNREFUSED" }).passed, false);
  assert.match(judgeDenied(read, { status: 200, body: {} }).why, /ALLOWED/);
  const tested = { test: true };
  assert.equal(judgeDenied(tested, { status: 200, body: {} }).passed, true);
  assert.equal(judgeDenied(tested, { status: 200, body: { permissions: ["run.services.update"] } }).passed, false);
});

test("the control must succeed through the same client", () => {
  assert.equal(judgeAllowed({}, { status: 200, body: {} }).passed, true);
  assert.equal(judgeAllowed({}, { status: 403, body: { error: { status: "PERMISSION_DENIED" } } }).passed, false);
  assert.equal(judgeAllowed({ notFoundIsSuccess: true }, { status: 404 }).passed, true);
  assert.equal(judgeAllowed({ test: true, body: { permissions: ["a"] } }, { status: 200, body: {} }).passed, false);
});

test("an IAM run reaches every check and redacts what an allowed call returns", async () => {
  const urls = [];
  const denied = async url => { urls.push(url); return new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "permission denied" } }), { status: 403 }); };
  const run = await runIam(iamConfig, "compiler", { token: "t", doFetch: async (url, init) => url.endsWith(":testIamPermissions") ? new Response("{}", { status: 200 }) : denied(url, init), idToken: async () => "a.b.c" });
  assert.equal(run.passed, true, JSON.stringify(run.rows.filter(r => !r.passed)));
  assert.ok(run.rows.find(r => r.positiveControl).passed);
  const leaky = await runIam({ secrets: iamConfig.secrets }, "compiler", { token: "t", doFetch: async () => new Response(JSON.stringify({ payload: { data: "c2VjcmV0" } }), { status: 200 }) });
  assert.equal(leaky.passed, false);
  assert.equal(leaky.rows[0].response.body.payload, "[redacted]");
});

test("a compiler run is void without a passing control from the same probe version", () => {
  const compiler = { role: "compiler", version: VERSION, passed: true, rows: [{ id: "secret projects/x/secrets/a", passed: true }, { id: "own id token for b", positiveControl: true, passed: true }] };
  const control = { role: "control", version: VERSION, passed: true, rows: [{ id: "secret projects/x/secrets/canary", passed: true }] };
  assert.deepEqual(combine(compiler, control), { void: false, passed: true });
  assert.equal(combine(compiler, { ...control, passed: false }).void, true);
  assert.equal(combine(compiler, { ...control, version: "other" }).void, true);
  assert.match(combine({ ...compiler, rows: [...compiler.rows, { id: "kms sign projects/k", passed: true }] }, control).why, /no control for: kms sign/);
});

// --- the D1 probe ---

const creds = { consumer: "test-consumer", secret: "test-secret-never-logged", domain: "localhost" };

test("a Data API case passes only when Learnosity refuses it", () => {
  assert.equal(judgeDataApi({ status: 403, body: { meta: { status: false, message: "Consumer not permitted" } } }).passed, true);
  assert.equal(judgeDataApi({ status: 200, body: { meta: { status: true } } }).passed, false);
  assert.equal(judgeDataApi({ error: "TimeoutError" }).passed, false);
  assert.equal(judgeDataApi({ status: 500, body: {} }).passed, false);
});

test("the server cases are signed with the given consumer and keep no secret in evidence", async () => {
  const sent = [];
  const rows = await runServer(creds, { doFetch: async (url, init) => { sent.push({ url, body: init.body.toString() }); return new Response(JSON.stringify({ meta: { status: false, message: "no" } }), { status: 403 }); } });
  assert.equal(rows.length, SERVER_CASES.length);
  assert.ok(rows.every(r => r.passed));
  assert.ok(sent.every(s => s.body.includes("test-consumer") && !s.body.includes("test-secret-never-logged")));
  assert.ok(!JSON.stringify(rows).includes("test-secret-never-logged"));
});

test("the browser harness carries signatures, never the secret, and only the preview control may initialize", () => {
  const page = harness(signedBrowserCases(creds));
  assert.ok(!page.includes("test-secret-never-logged"));
  assert.ok(page.includes("test-consumer"));
  const results = BROWSER_CASES.map(c => ({ id: c.id, outcome: c.control ? "initialized" : "refused" }));
  assert.equal(judgeBrowser(results).passed, true);
  const allowed = results.map(r => r.id === "items-initial" ? { ...r, outcome: "initialized" } : r);
  assert.equal(judgeBrowser(allowed).passed, false);
  const noControl = results.map(r => r.id.includes("control") ? { ...r, outcome: "refused" } : r);
  assert.deepEqual([judgeBrowser(noControl).void, judgeBrowser(noControl).passed], [true, false]);
});
