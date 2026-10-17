/* eslint-disable camelcase -- the proxy's access-log and the firewall log's fields are snake_case */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import https from "node:https";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MATRIX, CHECKS, classify, classifyBroker, classifyAuth, meets, runNet, connectTunnel, through, brokerRequest,
  dnsErrorKind, rowState, attributeNetwork, settleNetwork, judgeDnsRow, inCidr, PROXY_REASONS,
} from "../at11/net.js";

const expectedResult = e =>
  e === "succeeds"
    ? { outcome: "succeeds", status: 200 }
    : e === "nxdomain"
      ? { outcome: "nxdomain" }
      : e.startsWith("status:")
        ? { outcome: "succeeds", status: Number(e.slice(7)) }
        : e === "refused"
          ? { outcome: "refused:firewall" }
          : e === "refused:network"
            ? { outcome: "refused:network" }
            : e.includes("/")
              ? { outcome: e.split("/")[0], reason: e.split("/")[1] }
              : { outcome: e };
const fakeChecks = (kind, overrides = {}) => Object.fromEntries(MATRIX.map(r => [r.id, async () =>
  overrides[r.id] !== undefined ? overrides[r.id] : [{ target: "t", observation: {}, result: r[kind] === "residual" ? { outcome: "succeeds", status: 200 } : expectedResult(r[kind]), logCheck: { label: "x", queriedAt: "2026-10-17T00:00:00.000Z" } }]]));

test("the matrix has an expectation for every class kind, and every row a check", () => {
  for (const row of MATRIX) {
    for (const kind of ["default", "lang", "open"]) assert.ok(row[kind], `${row.id} ${kind}`);
    assert.equal(typeof CHECKS[row.id], "function", row.id);
  }
});

test("a refusal is identified by the control that made it, never just a failure", () => {
  assert.deepEqual(classify({ via: "proxy", stage: "connect", status: 403, headers: { "x-isolate01-refused": "unlisted" } }), { outcome: "refused:proxy", reason: "unlisted" });
  assert.deepEqual(classify({ via: "proxy", stage: "request", status: 403, headers: { "x-isolate01-refused": "host-mismatch" } }), { outcome: "refused:proxy", reason: "host-mismatch" });
  for (const reason of PROXY_REASONS) assert.equal(classify({ via: "proxy", stage: "connect", status: 403, headers: { "x-isolate01-refused": reason } }).outcome, "refused:proxy");
  assert.equal(classify({ via: "proxy", stage: "connect", status: 403, headers: { "x-isolate01-refused": "whatever" } }).outcome, "error", "an unknown reason is no refusal");
  // A 403 from the destination is the destination answering.
  assert.deepEqual(classify({ via: "proxy", stage: "request", status: 403, headers: {} }), { outcome: "succeeds", status: 403 });
  assert.equal(classify({ via: "proxy", stage: "connect", status: 407, headers: {} }).outcome, "error");
  assert.deepEqual(classify({ via: "direct", error: "timeout" }), { outcome: "refused:firewall" });
  assert.deepEqual(classify({ via: "direct", error: "nxdomain" }), { outcome: "nxdomain" });
  assert.equal(classify({ via: "direct", error: "EPROTO weird" }).outcome, "error");
});

test("a proxy that's down or resets is an error, and a CONNECT 5xx is only pending (A4)", () => {
  for (const error of ["timeout", "refused", "unreachable"]) {
    assert.equal(classify({ via: "proxy", error }).outcome, "error", `proxy ${error}`);
  }
  assert.deepEqual(classify({ via: "proxy", stage: "connect", status: 503, headers: {}, probe: "p1" }), { outcome: "pending:network", status: 503, probe: "p1" });
  // A bare 5xx can't pass a row expecting refused:network without the collector's evidence.
  assert.equal(rowState({ id: "rebinding" }, "refused:network", [{ result: { outcome: "pending:network" } }]), "pending-evidence");
  assert.equal(rowState({ id: "rebinding" }, "refused:network", [{ result: { outcome: "error" } }]), "failed");
});

test("expectations are met only by the named outcome and reason", () => {
  assert.ok(meets("refused:proxy/unlisted", { outcome: "refused:proxy", reason: "unlisted" }));
  assert.ok(!meets("refused:proxy/unlisted", { outcome: "refused:proxy", reason: "name" }));
  assert.ok(!meets("refused:proxy/unlisted", { outcome: "pending:network" }));
  assert.ok(meets("refused", { outcome: "refused:firewall" }));
  assert.ok(!meets("refused", { outcome: "succeeds", status: 200 }));
  assert.ok(!meets("refused", { outcome: "pending:network" }), "pending isn't a refusal");
  assert.ok(!meets("refused:firewall", { outcome: "error", detail: "x" }), "an unexplained failure never passes");
  assert.ok(meets("refused:broker/missing-execution-token", { outcome: "refused:broker", reason: "missing-execution-token" }));
  assert.ok(!meets("refused:broker/missing-execution-token", { outcome: "refused:broker", reason: "missing-x-caller-identity" }));
});

test("a run passes only when every applicable row ran and met its expectation", async () => {
  const config = { kind: "default", broker: { url: "https://b", relationship: "unlisted" } };
  const pending = await runNet(config, fakeChecks("default"));
  // dns-exfil always waits on the collector.
  assert.equal(pending.verdict, "pending");
  assert.equal(pending.passed, false);
  assert.equal(pending.rows.find(r => r.id === "dns-exfil").state, "pending-log");
  assert.ok(pending.rows.filter(r => r.id !== "dns-exfil").every(r => ["passed", "n/a"].includes(r.state)), JSON.stringify(pending.rows.filter(r => !["passed", "n/a", "pending-log"].includes(r.state))));
  const notRun = await runNet(config, fakeChecks("default", { unlisted: null }));
  assert.equal(notRun.verdict, "failed");
  assert.equal(notRun.rows.find(r => r.id === "unlisted").state, "not run");
  const failed = await runNet(config, fakeChecks("default", { unlisted: [{ target: "example.com", observation: {}, result: { outcome: "succeeds", status: 200 } }] }));
  assert.equal(failed.verdict, "failed");
  // For L0185 the relay is a residual: run and recorded, never a failure.
  const open = await runNet({ kind: "open", broker: { url: "https://b", relationship: "unlisted" } }, fakeChecks("open"));
  assert.equal(open.rows.find(r => r.id === "relay").state, "residual");
  assert.notEqual(open.verdict, "failed");
});

test("the Broker rows apply by relationship: exactly one runs, the others are n/a (A3)", async () => {
  const brokerRows = MATRIX.filter(r => r.broker).map(r => r.id);
  for (const [relationship, row] of [["unlisted", "broker-unlisted"], ["no-invoker", "broker-no-invoker"], ["invoker", "broker-no-token"]]) {
    for (const kind of ["default", "lang"]) {
      if (kind === "lang" && relationship === "invoker" && MATRIX.find(r => r.id === row).lang === "n/a") continue;
      const run = await runNet({ kind, broker: { url: "https://b", relationship } }, fakeChecks(kind));
      const states = Object.fromEntries(run.rows.filter(r => brokerRows.includes(r.id)).map(r => [r.id, r.state]));
      assert.equal(states[row], "passed", `${kind} ${relationship}: ${JSON.stringify(states)}`);
      assert.deepEqual(Object.entries(states).filter(([id]) => id !== row).map(([, s]) => s), ["n/a", "n/a"], `${kind} ${relationship}`);
    }
  }
  // The checks themselves run only for their own relationship.
  const calls = [];
  const deps = { idToken: async () => { calls.push("token"); throw new Error("no metadata here"); } };
  assert.equal(await CHECKS["broker-no-invoker"]({ broker: { url: "https://b", relationship: "invoker" } }, deps), null);
  assert.equal((await CHECKS["broker-no-token"]({ broker: { url: "https://b", relationship: "invoker" } }, deps))[0].result.outcome, "error");
  await assert.rejects(runNet({ kind: "default", broker: { url: "https://b", relationship: "listed" } }, fakeChecks("default")), /relationship must be one of/);
  await assert.rejects(runNet({ kind: "open", broker: { url: "https://b", relationship: "invoker" } }, fakeChecks("open")), /can't be listed/);
});

test("Broker's refusals are told apart: missing token, rejected caller, Cloud Run IAM (A13)", () => {
  const json = (status, message) => ({ via: "proxy", stage: "request", status, headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "error", error: { code: status, message }, data: null }) });
  const noToken = classifyBroker(json(401, "missing execution token"));
  assert.deepEqual(noToken, { outcome: "refused:broker", status: 401, reason: "missing-execution-token" });
  assert.ok(meets("refused:broker/missing-execution-token", noToken));
  const noCaller = classifyBroker(json(401, "missing X-Caller-Identity"));
  assert.ok(!meets("refused:broker/missing-execution-token", noCaller), "a caller rejection never passes the missing-token row");
  const cloudRun = classifyBroker({ via: "proxy", stage: "request", status: 403, headers: { "content-type": "text/html; charset=UTF-8" }, body: "<html><title>403 Forbidden</title>Your client does not have permission</html>" });
  assert.deepEqual(cloudRun, { outcome: "refused:cloudrun-iam", status: 403 });
  const brokerForbidden = classifyBroker({ ...json(403, "unknown caller"), headers: { "content-type": "text/html" } });
  assert.equal(brokerForbidden.outcome, "refused:broker", "Broker's own JSON 403 isn't Cloud Run's");
  assert.equal(classifyBroker({ via: "proxy", stage: "request", status: 200, headers: {}, body: "{}" }).outcome, "error");
  assert.equal(classifyBroker({ via: "proxy", stage: "connect", status: 403, headers: { "x-isolate01-refused": "unlisted" } }).outcome, "refused:proxy");
  // The request carries both identity headers and no Authorization.
  const request = brokerRequest({ broker: { url: "https://broker.example" } }, "id-token");
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/v1/execute");
  assert.deepEqual(Object.keys(request.headers).sort(), ["x-caller-identity", "x-serverless-authorization"]);
  assert.equal(request.headers["x-serverless-authorization"], "Bearer id-token");
  assert.ok(!("authorization" in request.headers));
});

test("auth's act-as refusal is recognised by its reason", () => {
  const body = message => JSON.stringify({ status: "error", error: { code: 403, message }, data: null });
  const unknown = classifyAuth({ via: "proxy", stage: "request", status: 403, headers: {}, body: body("unknown caller") });
  assert.ok(meets("refused:auth/unknown-caller", unknown));
  assert.ok(!meets("refused:auth/unknown-caller", classifyAuth({ via: "proxy", stage: "request", status: 401, headers: {}, body: body("invalid X-Caller-Identity") })));
  assert.equal(classifyAuth({ via: "proxy", stage: "request", status: 200, headers: {}, body: "{}" }).outcome, "error", "an accepted act-as is never a pass");
});

// --- a CONNECT proxy and a TLS origin, for the transport tests ---

function makeCert(names) {
  const dir = mkdtempSync(path.join(tmpdir(), "at11-cert-"));
  const san = names.map(n => `DNS:${n}`).join(",");
  const r = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${dir}/key.pem`, "-out", `${dir}/cert.pem`, "-days", "1", "-subj", `/CN=${names[0]}`, "-addext", `subjectAltName=${san}`], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`openssl: ${r.stderr}`);
  const out = { key: readFileSync(`${dir}/key.pem`), cert: readFileSync(`${dir}/cert.pem`) };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

// A CONNECT proxy that sends every tunnel to `port` on 127.0.0.1, recording each CONNECT head.
async function connectProxy(port, heads) {
  const server = net.createServer(client => client.once("data", head => {
    heads.push(head.toString());
    const upstream = net.connect(port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server;
}

const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

test("the Broker request reaches a real Broker app as a POST with both identity headers (A13)", async () => {
  const { createBrokerApp } = await import("@graffiticode/broker");
  const { UnauthenticatedError, UnauthorizedError } = await import("@graffiticode/common/errors");
  const tls = makeCert(["broker.test"]);
  // Broker's own app, with a caller check like createCallerIdentity's.
  const app = createBrokerApp({
    broker: { execute: async () => { throw new Error("execute must not be reached without a token"); }, protectedExecution: async () => ({}) },
    secrets: {},
    audit: async () => {},
    identifyCaller: async req => {
      const token = req.get("X-Caller-Identity");
      if (!token) throw new UnauthenticatedError("missing X-Caller-Identity");
      if (token !== "id-l0176") throw new UnauthorizedError("unknown caller");
      return { email: "l0176-run@graffiticode.iam.gserviceaccount.com" };
    },
  });
  const seen = [];
  const invokers = new Set(["id-l0176"]);
  // Cloud Run in front of it: an invoker token in X-Serverless-Authorization, or its own HTML 403.
  const origin = https.createServer(tls, (req, res) => {
    seen.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    const invoker = (req.headers["x-serverless-authorization"] ?? "").replace(/^Bearer /, "");
    if (!invokers.has(invoker)) {
      res.writeHead(403, { "content-type": "text/html; charset=UTF-8" });
      return res.end("<html><head><title>403 Forbidden</title></head><body>Your client does not have permission to get URL /v1/execute from this server.</body></html>");
    }
    app(req, res);
  });
  const originPort = await listen(origin);
  const heads = [];
  const proxy = await connectProxy(originPort, heads);
  const config = { proxy: `http://127.0.0.1:${proxy.address().port}`, ca: tls.cert, timeoutMs: 5000, nonce: "n1" };
  try {
    // The listed-invoker row: the request is made exactly as a compiler makes it.
    const [result] = await CHECKS["broker-no-token"]({ ...config, broker: { url: "https://broker.test", relationship: "invoker" } }, { idToken: async () => "id-l0176" });
    assert.deepEqual(result.result, { outcome: "refused:broker", status: 401, reason: "missing-execution-token" }, JSON.stringify(result.observation));
    const sent = seen.at(-1);
    assert.equal(sent.method, "POST");
    assert.equal(sent.url, "/v1/execute");
    assert.equal(sent.headers["x-serverless-authorization"], "Bearer id-l0176");
    assert.equal(sent.headers["x-caller-identity"], "id-l0176");
    assert.equal(sent.headers.authorization, undefined, "no Authorization: that's where the execution token goes");
    assert.ok(sent.headers["x-isolate01-probe"].startsWith("n1-"), "the inner request carries the probe id");
    assert.match(heads.at(-1), /^CONNECT broker\.test:443 HTTP\/1\.1\r\n/);
    assert.match(heads.at(-1), new RegExp(`x-isolate01-probe: ${sent.headers["x-isolate01-probe"]}\\r\\n`), "the CONNECT carries the same probe id");

    // Without X-Caller-Identity, Broker rejects the caller: a 401 the row doesn't accept.
    const request = brokerRequest({ broker: { url: "https://broker.test" } }, "id-l0176");
    delete request.headers["x-caller-identity"];
    const { authority, ...rest } = request;
    const observation = await through(config, authority, rest);
    const noCaller = classifyBroker(observation);
    assert.equal(noCaller.outcome, "refused:broker");
    assert.equal(noCaller.reason, "missing-x-caller-identity");
    assert.ok(!meets(MATRIX.find(r => r.id === "broker-no-token").default, noCaller));

    // The listed-without-invoker row: Cloud Run's own refusal, before Broker.
    const [noInvoker] = await CHECKS["broker-no-invoker"]({ ...config, broker: { url: "https://broker.test", relationship: "no-invoker" } }, { idToken: async () => "id-l0003" });
    assert.deepEqual(noInvoker.result, { outcome: "refused:cloudrun-iam", status: 403 });
    assert.ok(meets(MATRIX.find(r => r.id === "broker-no-invoker").default, noInvoker.result));
  } finally {
    proxy.close();
    origin.close();
  }
});

test("connectTunnel reads the proxy's status and refusal header", async () => {
  const server = net.createServer(socket => socket.once("data", head => {
    const target = head.toString().split(" ")[1];
    if (target.startsWith("down.")) socket.end("HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n");
    else if (target.startsWith("ok.")) socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    else socket.end("HTTP/1.1 403 Forbidden\r\nX-Isolate01-Refused: unlisted\r\ncontent-length: 0\r\n\r\n");
  }));
  const port = await listen(server);
  const proxy = `http://127.0.0.1:${port}`;
  try {
    assert.deepEqual(classify(await connectTunnel(proxy, "example.com:443")), { outcome: "refused:proxy", reason: "unlisted" });
    assert.equal(classify(await connectTunnel(proxy, "down.test:443", 5000, "p9")).outcome, "pending:network");
    const open = await connectTunnel(proxy, "ok.test:443");
    assert.equal(open.status, 200);
    open.socket.destroy();
  } finally {
    server.close();
  }
});

test("a proxy that isn't there can't pass the rebinding row", async () => {
  const closed = net.createServer();
  const port = await listen(closed);
  await new Promise(resolve => closed.close(resolve));
  const config = { kind: "open", proxy: `http://127.0.0.1:${port}`, rebinding: ["meta.rebind.example"], timeoutMs: 2000 };
  const [result] = await CHECKS.rebinding(config);
  assert.equal(result.result.outcome, "error");
  assert.equal(rowState({ id: "rebinding" }, "refused:network", [result]), "failed");
});

// --- A14: refused:network needs the address, the rule hit and a canary ---

const blocked = { compilerSubnets: ["10.20.0.0/20"], proxySubnet: "10.8.0.0/28", loadBalancer: "10.8.0.2" };
const pendingRow = probe => ({ id: "rebinding", title: "r", expected: "refused:network", state: "pending-evidence", results: [{ target: "meta.rebind.example", observation: {}, result: { outcome: "pending:network", status: 503, probe } }] });
const canaryRow = state => ({ id: "canary", title: "c", expected: "succeeds", state, results: [] });

test("the blocked ranges are the plan's, plus the compiler and proxy subnets and the load balancer", () => {
  assert.ok(inCidr("169.254.169.254", "169.254.0.0/16"));
  assert.ok(inCidr("199.36.153.9", "199.36.153.8/30"));
  assert.ok(!inCidr("199.36.153.12", "199.36.153.8/30"));
  assert.ok(!inCidr("203.0.113.9", "10.0.0.0/8"));
  assert.ok(!inCidr("::1", "127.0.0.0/8"));
});

test("a connect failure is refused:network only with the blocked address, its rule hit and a canary (A14)", () => {
  const access = [{ isolate01: "egress", probe: "p1", upstream_host: "169.254.169.254:443", decision: "refuse", flags: "UF" }];
  const kernel = ["Oct 17 01:02:03 egress-proxy-a kernel: ISOLATE01-REJECT private IN= OUT=eth0 SRC=10.8.0.3 DST=169.254.169.254 LEN=60 PROTO=TCP SPT=40000 DPT=443"];
  const ok = attributeNetwork({ outcome: "pending:network", probe: "p1" }, { accessLines: access, kernelLines: kernel, canaryPassed: true, blocked });
  assert.equal(ok.outcome, "refused:network");
  // A VPC firewall-log hit for the address does as well.
  assert.equal(attributeNetwork({ outcome: "pending:network", probe: "p1" }, { accessLines: access, firewallHits: [{ connection: { dest_ip: "169.254.169.254" } }], canaryPassed: true, blocked }).outcome, "refused:network");
  assert.equal(attributeNetwork({ outcome: "pending:network", probe: "p1" }, { accessLines: access, kernelLines: kernel, canaryPassed: false, blocked }).outcome, "error", "no canary");
  assert.equal(attributeNetwork({ outcome: "pending:network", probe: "p1" }, { accessLines: access, kernelLines: [], canaryPassed: true, blocked }).outcome, "error", "no rule hit");
  assert.equal(attributeNetwork({ outcome: "pending:network", probe: "p2" }, { accessLines: access, kernelLines: kernel, canaryPassed: true, blocked }).outcome, "error", "no access line for this probe");
  const otherDst = ["kernel: ISOLATE01-REJECT private DST=169.254.169.2 DPT=443"];
  assert.equal(attributeNetwork({ outcome: "pending:network", probe: "p1" }, { accessLines: access, kernelLines: otherDst, canaryPassed: true, blocked }).outcome, "error", "a hit for another address");
  const lb = [{ isolate01: "egress", probe: "p3", upstream_host: "10.8.0.2:443" }];
  assert.equal(attributeNetwork({ outcome: "pending:network", probe: "p3" }, { accessLines: lb, kernelLines: ["ISOLATE01-REJECT lb DST=10.8.0.2 DPT=443"], canaryPassed: true, blocked }).outcome, "refused:network");
});

test("an unreachable public target can't pass the rebinding row (A14)", () => {
  // The upstream is public and simply down: the same CONNECT 503, no rule fired.
  const net = { rows: [pendingRow("p1"), canaryRow("passed")] };
  const evidence = { accessLines: [{ isolate01: "egress", probe: "p1", upstream_host: "203.0.113.9:443", decision: "refuse", flags: "UF" }], kernelLines: [], firewallHits: [], blocked };
  const settled = settleNetwork(net, evidence);
  assert.equal(settled.rows[0].state, "failed");
  assert.match(settled.rows[0].results[0].result.detail, /isn't in a blocked range/);
  // Even a stray rule hit for that address doesn't make it pass.
  const withHit = settleNetwork(net, { ...evidence, kernelLines: ["ISOLATE01-REJECT private DST=203.0.113.9 DPT=443"] });
  assert.equal(withHit.rows[0].state, "failed");
  // The same evidence for a blocked address, with the canary, passes.
  const good = settleNetwork(net, { accessLines: [{ isolate01: "egress", probe: "p1", upstream_host: "10.1.2.3:443" }], kernelLines: ["ISOLATE01-REJECT private DST=10.1.2.3 DPT=443"], blocked });
  assert.equal(good.rows[0].state, "passed");
  // Without the canary's pass in the same run, it fails.
  assert.equal(settleNetwork({ rows: [pendingRow("p1"), canaryRow("failed")] }, { accessLines: [{ isolate01: "egress", probe: "p1", upstream_host: "10.1.2.3:443" }], kernelLines: ["ISOLATE01-REJECT private DST=10.1.2.3 DPT=443"], blocked }).rows[0].state, "failed");
});

// --- A17: only a genuine NXDOMAIN, and the verdict waits for the log ---

test("only ENOTFOUND is an NXDOMAIN (A17)", async () => {
  assert.equal(dnsErrorKind({ code: "ENOTFOUND" }), "nxdomain");
  for (const code of ["ENODATA", "ESERVFAIL", "EREFUSED", "ETIMEOUT", "ECONNREFUSED"]) assert.notEqual(dnsErrorKind({ code }), "nxdomain", code);
  const config = { dnsExfil: "exfil.example" };
  for (const code of ["ENODATA", "ESERVFAIL", "EREFUSED", "ETIMEOUT"]) {
    const results = await CHECKS["dns-exfil"](config, { resolve4: async () => { throw Object.assign(new Error(code), { code }); } });
    assert.equal(results[0].result.outcome, "error", code);
    assert.equal(rowState({ id: "dns-exfil" }, "nxdomain", results), "failed", code);
  }
  const answered = await CHECKS["dns-exfil"](config, { resolve4: async () => ["1.2.3.4"] });
  assert.equal(rowState({ id: "dns-exfil" }, "nxdomain", answered), "failed");
  const nx = await CHECKS["dns-exfil"](config, { resolve4: async () => { throw Object.assign(new Error("x"), { code: "ENOTFOUND" }); } });
  assert.equal(rowState({ id: "dns-exfil" }, "nxdomain", nx), "pending-log", "the job never passes the row itself");
  assert.match(nx[0].logCheck.label, /^at11-[0-9a-f]{16}$/);
});

test("the DNS row is decided from a log that recorded the collector's control (A17, A24)", () => {
  const row = { id: "dns-exfil", results: [{ target: "at11-aaa.exfil.example", result: { outcome: "nxdomain" }, logCheck: { label: "at11-aaa", queriedAt: "2026-10-17T10:00:00.000Z" } }] };
  const control = { label: "at11-ctl-bbb", sentAt: "2026-10-17T10:05:00.000Z" };
  const log = { text: "query: at11-ctl-bbb.exfil.example IN A\n", from: "2026-10-17T09:59:00.000Z", to: "2026-10-17T10:06:00.000Z", fetchedAt: "2026-10-17T10:07:00.000Z" };
  assert.deepEqual(judgeDnsRow(row, log, control), { state: "passed", leaked: [] });
  assert.equal(judgeDnsRow(row, { ...log, text: log.text + "query: at11-aaa.exfil.example IN A\n" }, control).state, "failed");
  assert.equal(judgeDnsRow(row, { ...log, text: "" }, control).state, "void", "an empty log proves nothing");
  assert.equal(judgeDnsRow(row, { ...log, text: "query: other.exfil.example\n" }, control).state, "void", "no control label");
  assert.equal(judgeDnsRow(row, { ...log, fetchedAt: "2026-10-17T10:04:00.000Z" }, control).state, "void", "a log fetched before the control");
  assert.equal(judgeDnsRow(row, { ...log, from: "2026-10-17T10:01:00.000Z" }, control).state, "void", "the window starts after the compiler's query");
  assert.equal(judgeDnsRow(row, { ...log, to: "2026-10-17T10:04:00.000Z" }, control).state, "void", "the window ends before the control");
  assert.equal(judgeDnsRow(row, log, null).state, "void");
  assert.equal(judgeDnsRow({ ...row, results: [{ ...row.results[0], result: { outcome: "error" } }] }, log, control).state, "failed");
});
