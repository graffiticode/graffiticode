import test from "node:test";
import assert from "node:assert/strict";
import { SCRATCH_METRIC_PREFIX, SCRATCH_POLICY, SYSTEM_PREVIEW_LIMIT_SOURCES, TEST_LOG, alertSpecs, apply, checkFilters, cleanupThreshold, confirmDelivery, desiredPolicy, metricSpecs, plan, policyChanged, thresholdCondition, verifyThreshold, writeTestRecords } from "../lib/monitoring.js";
import { parse } from "../monitoring.js";

/* eslint-disable camelcase -- Cloud Monitoring and Logging label keys are snake_case */

const P = "graffiticode";

// Just enough of the Logging query language to evaluate the filters this
// script generates against an entry: AND, OR, NOT, parentheses, `=` on a
// string or a parenthesized OR of strings, and `=~` (a regular expression).
// As in Logging, OR binds tighter than AND.
const matches = (filter, entry) => {
  const tokens = [];
  for (let i = 0; i < filter.length;) {
    const c = filter[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(" || c === ")") { tokens.push(c); i++; continue; }
    if (c === "\"") {
      let j = i + 1;
      let v = "";
      while (filter[j] !== "\"") { if (filter[j] === "\\") j++; v += filter[j++]; }
      tokens.push({ str: v });
      i = j + 1;
      continue;
    }
    if (filter.startsWith("=~", i)) { tokens.push("=~"); i += 2; continue; }
    if (c === "=") { tokens.push("="); i++; continue; }
    const word = filter.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.]*/)[0];
    tokens.push(word);
    i += word.length;
  }
  let at = 0;
  const peek = () => tokens[at];
  const take = expected => {
    const t = tokens[at++];
    if (expected && t !== expected) throw new Error(`expected ${expected} at ${at - 1}, got ${JSON.stringify(t)}`);
    return t;
  };
  const lookup = path => path.split(".").reduce((v, k) => v?.[k], entry);
  const comparison = () => {
    const path = take();
    const op = take();
    if (op === "=~") return new RegExp(take().str).test(String(lookup(path) ?? ""));
    if (op !== "=") throw new Error(`unknown operator ${op}`);
    const values = [];
    if (peek() === "(") {
      take("(");
      values.push(take().str);
      while (peek() === "OR") { take("OR"); values.push(take().str); }
      take(")");
    } else values.push(take().str);
    return values.includes(lookup(path));
  };
  const unary = () => {
    if (peek() === "NOT") { take(); return !unary(); }
    if (peek() === "(") { take("("); const v = and(); take(")"); return v; }
    return comparison();
  };
  const or = () => { let v = unary(); while (peek() === "OR") { take(); v = unary() || v; } return v; };
  const and = () => { let v = or(); while (peek() === "AND") { take(); v = or() && v; } return v; };
  const v = and();
  if (at !== tokens.length) throw new Error(`unparsed from ${at}: ${JSON.stringify(tokens.slice(at))}`);
  return v;
};

// Entries as Cloud Logging holds the audit lines (createAudit's output in
// jsonPayload; the service from Cloud Run). Field values as the services
// write them today: Policy's mint record (policy.ts mint/deny), Broker's
// execute record (broker.ts `record`), api's audit (api/src/audit.js).
const entry = (svc, payload) => ({
  logName: `projects/${P}/logs/run.googleapis.com%2Fstdout`,
  resource: { type: "cloud_run_revision", labels: { service_name: svc, revision_name: `${svc}-00042-abc`, location: "us-central1" } },
  jsonPayload: { logName: "security_audit", at: "2026-10-15T12:00:00.000Z", requestId: "3f6c1a2e-1111-4222-8333-944455556666", ...payload },
});
const SYS = {
  user: "a1b2c3d4e5f6a1b2c3d4e5f6",
  owner: "0f9e8d7c6b5a0f9e8d7c6b5a",
  lang: "0176",
  connectionId: "conn-system-learnosity",
  fn: "init",
  op: "learnosity.sign-items-preview",
  registryVersion: 7,
  invocationId: "sys-5d1e7a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
  stage: "preview",
};
const records = {
  policyRateLimited: entry("policy", { event: "mint", ...SYS, callerRole: "compiler", provenance: "system", outcome: "denied", reason: "rate-limited", category: "unavailable" }),
  brokerExhausted: entry("broker", { event: "execute", ...SYS, jti: "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d", opid: `${SYS.invocationId}/preview/occ-1`, provenance: "system", callerRole: "compiler", outcome: "denied", reason: "session-exhausted", category: "unavailable" }),
  api429: entry("api", { event: "system-signing-limit", outcome: "denied", reason: "rate-limited", category: "unavailable" }),
  systemSignature: entry("broker", { event: "execute", ...SYS, jti: "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e", opid: `${SYS.invocationId}/preview/occ-2`, provenance: "system", callerRole: "compiler", outcome: "allowed" }),
  systemStep: entry("broker", { event: "execute-step", ...SYS, jti: "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e", opid: `${SYS.invocationId}/preview/occ-2`, provenance: "system", callerRole: "compiler", step: "sign", purpose: "sign", decisionId: "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f", outcome: "allowed" }),
  connectionSignature: entry("broker", { event: "execute", ...SYS, connectionId: "conn-alice-learnosity", invocationId: "inv-2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e", opid: "inv-2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e/s0/occ-1", stage: "s0", jti: "9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a", provenance: "user", callerRole: "compiler", outcome: "allowed" }),
  publicationSignature: entry("broker", { event: "execute", ...SYS, connectionId: "conn-alice-learnosity", provenance: "publication", callerRole: "compiler", outcome: "allowed" }),
};

// Just enough of Cloud Logging and Cloud Monitoring: metrics, channels,
// alert policies, entry counts by filter, and every write.
const fakeGoogle = ({ count = () => 5 } = {}) => {
  const metrics = new Map();
  const channels = [];
  const policies = [];
  const writes = [];
  const listed = [];
  const counts = new Map();
  const timeSeries = [];
  let ids = 0;
  const api = async (method, url, body) => {
    const u = new URL(url);
    if (method !== "GET" && !u.pathname.endsWith("/entries:list")) writes.push({ method, path: u.pathname, body });
    if (u.pathname.endsWith("/entries:list")) {
      listed.push(body.filter);
      return { status: 200, json: { entries: Array(Math.min(count(body.filter), body.pageSize)).fill({}) } };
    }
    if (u.pathname.endsWith("/entries:write")) {
      // Counted by any metric whose filter matches (the scratch metrics).
      for (const e of body.entries) {
        const entry = { logName: body.logName, resource: body.resource, ...e };
        for (const [name, m] of metrics) if (matches(m.filter, entry)) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      return { status: 200, json: {} };
    }
    if (u.pathname.endsWith("/timeSeries") && method === "GET") {
      timeSeries.push(Object.fromEntries(u.searchParams));
      const name = u.searchParams.get("filter").match(/user\/([^"]+)"/)[1];
      const value = counts.get(name) ?? 0;
      return { status: 200, json: value ? { timeSeries: [{ points: [{ value: { int64Value: String(value) } }] }] } : {} };
    }
    if (u.pathname.endsWith("/metrics") && method === "GET") return { status: 200, json: { metrics: [...metrics.values()].map(m => structuredClone(m)) } };
    const metric = u.pathname.match(/\/metrics\/(.+)$/);
    if (metric) {
      const name = decodeURIComponent(metric[1]);
      if (method === "GET") return metrics.has(name) ? { status: 200, json: structuredClone(metrics.get(name)) } : { status: 404, json: {} };
      if (method === "PUT") { metrics.set(name, structuredClone(body)); return { status: 200, json: body }; }
      if (method === "DELETE") { metrics.delete(name); return { status: 200, json: {} }; }
    }
    if (u.pathname.endsWith("/metrics") && method === "POST") {
      if (metrics.has(body.name)) return { status: 409, json: {} };
      metrics.set(body.name, structuredClone(body));
      return { status: 200, json: body };
    }
    if (u.pathname.endsWith("/notificationChannels")) {
      if (method === "GET") return { status: 200, json: { notificationChannels: structuredClone(channels) } };
      const created = { ...body, name: `projects/${P}/notificationChannels/${++ids}` };
      channels.push(created);
      return { status: 200, json: created };
    }
    if (u.pathname.endsWith("/alertPolicies")) {
      if (method === "GET") {
        const name = u.searchParams.get("filter").match(/display_name="(.*)"/)[1];
        return { status: 200, json: { alertPolicies: structuredClone(policies.filter(p => p.displayName === name)) } };
      }
      // Like Monitoring: the server names the policy and its conditions.
      const created = { ...structuredClone(body), name: `projects/${P}/alertPolicies/${++ids}`, conditions: body.conditions.map((c, i) => ({ ...c, name: `c${ids}-${i}` })), creationRecord: { mutateTime: "t" } };
      policies.push(created);
      return { status: 200, json: created };
    }
    const policy = u.pathname.match(/\/(projects\/[^/]+\/alertPolicies\/\d+)$/);
    if (policy && method === "DELETE") {
      policies.splice(policies.findIndex(p => p.name === policy[1]), 1);
      return { status: 200, json: {} };
    }
    if (policy && method === "PATCH") {
      const i = policies.findIndex(p => p.name === policy[1]);
      policies[i] = { ...policies[i], ...structuredClone(body), name: policy[1] };
      return { status: 200, json: policies[i] };
    }
    return { status: 500, json: { error: `unhandled ${method} ${u.pathname}` } };
  };
  return { api, metrics, channels, policies, writes, listed, timeSeries };
};

const spec = id => metricSpecs(P).find(s => s.id === id);

test("every metric reads only the security audit on the service that writes it", () => {
  for (const s of metricSpecs(P)) {
    assert.ok(s.filter.startsWith(`logName="projects/${P}/logs/run.googleapis.com%2Fstdout" AND jsonPayload.logName="security_audit" AND resource.type="cloud_run_revision" AND resource.labels.service_name=`), s.id);
    assert.ok(s.filter.startsWith(s.base), s.id);
    assert.ok(!s.filter.includes(TEST_LOG) && !s.filter.includes("monitoring-test"), `${s.id} must not count test records`);
  }
  assert.equal(new Set(metricSpecs(P).map(s => s.name)).size, metricSpecs(P).length);
});

test("one count per failure: relayed denials, replays and test records are not counted twice", () => {
  // Broker's relay of a Policy denial is Policy's denial.
  assert.match(spec("broker_local_refusals").filter, /NOT jsonPayload\.reason=~"\^authorization-denied:"/);
  assert.match(spec("policy_denials").filter, /service_name="policy" AND jsonPayload\.outcome="denied"$/);
  // A replay of an uncertain write is a replay (outcome replayed, reason uncertain).
  assert.match(spec("uncertain_writes").filter, /jsonPayload\.event="execute" AND jsonPayload\.outcome="uncertain"$/);
  assert.match(spec("receipt_replays").filter, /jsonPayload\.outcome="replayed"$/);
  assert.match(spec("authorization_outages").filter, /service_name="broker" AND jsonPayload\.event="execute" AND jsonPayload\.reason="authorization-unavailable"$/);
  assert.match(spec("artifact_failures").filter, /service_name="api" AND jsonPayload\.event="artifact" AND jsonPayload\.outcome="failed"$/);
});

test("each alert's own condition matches its test record, and the real records", () => {
  const [outage, uncertain] = alertSpecs(P);
  for (const a of [outage, uncertain]) assert.ok(a.filter.includes(`logName="projects/${P}/logs/${TEST_LOG}" AND jsonPayload.logName="security_audit" AND jsonPayload.event="monitoring-test"`));
  assert.ok(outage.filter.includes(spec("authorization_outages").filter) && outage.filter.includes(spec("gateway_policy_unavailable").filter));
  assert.match(outage.filter, /monitoring-test" AND jsonPayload\.reason="authorization-unavailable"\)$/);
  assert.deepEqual(outage.test, { outcome: "failed", reason: "authorization-unavailable" });
  assert.ok(uncertain.filter.includes(spec("uncertain_writes").filter));
  assert.match(uncertain.filter, /monitoring-test" AND jsonPayload\.outcome="uncertain"\)$/);
  assert.deepEqual(uncertain.test, { outcome: "uncertain" });
});

// AUDIT-01 (W5): partial writes, artifact storage outages and permission
// denials outside the canary are alerted too.
test("the new alerts match their own records and test records, and the denial alert leaves the canary out", () => {
  const alerts = Object.fromEntries(alertSpecs(P, { canaryConnections: ["conn-canary"] }).map(a => [a.id, a]));
  assert.deepEqual(Object.keys(alerts), ["outage", "uncertain", "partial", "artifact", "denial", "rate-limited", "system-signings"]);
  assert.ok(alerts.partial.filter.includes(spec("partial_writes").filter));
  assert.ok(alerts.artifact.filter.includes(`${spec("artifact_failures").filter} AND jsonPayload.category="unavailable"`));
  for (const id of ["policy_denials", "broker_local_refusals", "api_denials"]) assert.ok(alerts.denial.filter.includes(spec(id).filter), id);
  assert.match(alerts.denial.filter, /jsonPayload\.category="permission" AND NOT jsonPayload\.connectionId="conn-canary"\)/);
  // Each test record carries what its own test clause matches.
  assert.match(alerts.partial.filter, /monitoring-test" AND jsonPayload\.outcome="partial"\)$/);
  assert.match(alerts.artifact.filter, /monitoring-test" AND jsonPayload\.reason="artifact-storage-unavailable"\)$/);
  assert.match(alerts.denial.filter, /monitoring-test" AND jsonPayload\.outcome="denied" AND jsonPayload\.category="permission"\)$/);
  assert.equal(alertSpecs(P).find(a => a.id === "denial").filter.includes("NOT jsonPayload.connectionId"), false);
  assert.match(spec("api_denials").filter, /service_name="api" AND jsonPayload\.outcome="denied"$/);
});

test("the filter check fails a metric whose records match nothing, or that the canary should fill", async () => {
  const replays = spec("receipt_replays");
  const g = fakeGoogle({ count: f => f.includes("service_name=\"api\"") ? 0 : f.includes(replays.match) ? 0 : 3 });
  const since = "2026-10-01T00:00:00Z";
  const checks = await checkFilters({ api: g.api, project: P, since });
  const byName = Object.fromEntries(checks.map(c => [c.name.split("/")[1], c]));
  assert.equal(byName.artifact_failures.problem, "its records match no deployed entries");
  assert.equal(byName.gateway_policy_unavailable.problem, "its records match no deployed entries");
  assert.equal(byName.receipt_replays.problem, "the canary's records of this kind match nothing");
  assert.equal(byName.policy_denials.problem, null);
  // Rare failures may match nothing, as long as their records exist.
  assert.equal(byName.uncertain_writes.problem, null);
  assert.ok(g.listed.every(f => f.endsWith(` AND timestamp>="${since}"`)));
  assert.equal(g.writes.length, 0);
});

test("a dry run writes nothing", async () => {
  const g = fakeGoogle();
  const { steps } = await plan({ api: g.api, project: P, email: "ops@example.com" });
  assert.deepEqual(steps.map(s => s.action), Array(steps.length).fill("create"));
  assert.deepEqual(steps.map(s => s.kind), [...Array(metricSpecs(P).length).fill("metric"), "channel", ...Array(alertSpecs(P).length).fill("policy")]);
  assert.equal(g.writes.length, 0);
});

test("apply creates everything once, and a second apply changes nothing", async () => {
  const g = fakeGoogle();
  await apply({ api: g.api, project: P, email: "ops@example.com" });
  assert.equal(g.metrics.size, metricSpecs(P).length);
  assert.equal(g.channels.length, 1);
  assert.equal(g.policies.length, alertSpecs(P).length);
  assert.ok(g.policies.every(p => p.notificationChannels[0] === g.channels[0].name));
  const outage = g.policies.find(p => p.displayName === "Security audit: authorization outage");
  assert.equal(outage.conditions[0].conditionMatchedLog.labelExtractors.nonce, "EXTRACT(jsonPayload.nonce)");
  assert.match(outage.documentation.content, /Nonce: \$\{log\.extracted_label\.nonce\}/);
  assert.equal(outage.alertStrategy.notificationRateLimit.period, "300s");
  const before = g.writes.length;
  const again = await apply({ api: g.api, project: P, email: "ops@example.com" });
  assert.ok(again.every(s => s.action === "unchanged"));
  assert.equal(g.writes.length, before);
});

test("apply updates only what drifted, and reuses an existing channel", async () => {
  const g = fakeGoogle();
  g.channels.push({ name: `projects/${P}/notificationChannels/77`, type: "email", labels: { email_address: "ops@example.com" } });
  await apply({ api: g.api, project: P, email: "ops@example.com" });
  assert.equal(g.channels.length, 1);
  g.metrics.get("security_audit/uncertain_writes").filter = "changed by hand";
  g.policies[0].enabled = false;
  const before = g.writes.length;
  const steps = await apply({ api: g.api, project: P, email: "ops@example.com" });
  assert.deepEqual(steps.filter(s => s.action !== "unchanged").map(s => `${s.action} ${s.name}`), ["update security_audit/uncertain_writes", `update ${g.policies[0].displayName}`]);
  assert.deepEqual(g.writes.slice(before).map(w => w.method), ["PUT", "PATCH"]);
  assert.equal(g.metrics.get("security_audit/uncertain_writes").filter, spec("uncertain_writes").filter);
  assert.equal(g.policies[0].enabled, true);
});

test("alert verification writes a test record per alert that its own condition matches", async () => {
  const g = fakeGoogle();
  await apply({ api: g.api, project: P, email: "ops@example.com" });
  const before = g.writes.length;
  const nonces = ["n0nce001", "n0nce002", "n0nce003", "n0nce004", "n0nce005", "n0nce006"];
  const written = await writeTestRecords({ api: g.api, project: P, email: "ops@example.com", nonce: () => nonces.shift(), now: () => new Date("2026-10-06T22:00:00Z") });
  const records = g.writes.slice(before);
  // One per log-match alert; the threshold alert has its own check.
  assert.deepEqual(records.map(w => w.path), Array(6).fill("/v2/entries:write"));
  assert.deepEqual(records.map(w => w.body.logName), Array(6).fill(`projects/${P}/logs/${TEST_LOG}`));
  const at = "2026-10-06T22:00:00.000Z";
  assert.deepEqual(records.map(w => w.body.entries[0].jsonPayload), [
    { logName: "security_audit", event: "monitoring-test", outcome: "failed", reason: "authorization-unavailable", nonce: "n0nce001", at },
    { logName: "security_audit", event: "monitoring-test", outcome: "uncertain", nonce: "n0nce002", at },
    { logName: "security_audit", event: "monitoring-test", outcome: "partial", nonce: "n0nce003", at },
    { logName: "security_audit", event: "monitoring-test", outcome: "failed", reason: "artifact-storage-unavailable", category: "unavailable", nonce: "n0nce004", at },
    { logName: "security_audit", event: "monitoring-test", outcome: "denied", reason: "not-granted", category: "permission", nonce: "n0nce005", at },
    { logName: "security_audit", event: "monitoring-test", outcome: "denied", reason: "rate-limited", category: "unavailable", nonce: "n0nce006", at },
  ]);
  // Each test record opens its own alert and no other.
  const logAlerts = alertSpecs(P).filter(a => a.test);
  records.forEach((w, i) => {
    const e = { logName: w.body.logName, resource: w.body.resource, ...w.body.entries[0] };
    assert.deepEqual(logAlerts.filter(a => matches(a.filter, e)).map(a => a.id), [logAlerts[i].id]);
  });
  assert.deepEqual(written.map(w => [w.alert, w.nonce]), [
    ["Security audit: authorization outage", "n0nce001"], ["Security audit: uncertain write", "n0nce002"], ["Security audit: partial write", "n0nce003"],
    ["Security audit: artifact storage outage", "n0nce004"], ["Security audit: permission denial", "n0nce005"],
    ["Security audit: system preview signing rate-limited", "n0nce006"],
  ]);
});

test("delivery is confirmed per alert by the nonce from its email, in any order", () => {
  const written = [{ alert: "outage", nonce: "aa11bb22", writtenAt: "t0" }, { alert: "uncertain", nonce: "cc33dd44", writtenAt: "t0" }];
  const both = confirmDelivery(written, [" CC33DD44 ", "aa11bb22"]);
  assert.deepEqual(both.results.map(r => [r.alert, r.delivered]), [["outage", true], ["uncertain", true]]);
  assert.deepEqual(both.unknown, []);
  const one = confirmDelivery(written, ["aa11bb22", "deadbeef"]);
  assert.deepEqual(one.results.map(r => [r.alert, r.delivered]), [["outage", true], ["uncertain", false]]);
  assert.deepEqual(one.unknown, ["deadbeef"]);
  assert.ok(confirmDelivery(written, []).results.every(r => !r.delivered));
});

test("alert verification refuses until monitoring is applied as specified", async () => {
  const g = fakeGoogle();
  await assert.rejects(writeTestRecords({ api: g.api, project: P, email: "ops@example.com" }), /not applied.*run --apply first/);
  await apply({ api: g.api, project: P, email: "ops@example.com" });
  g.policies[1].conditions[0].conditionMatchedLog.filter = "drifted";
  await assert.rejects(writeTestRecords({ api: g.api, project: P, email: "ops@example.com" }), /policy Security audit: uncertain write/);
  assert.ok(!g.writes.some(w => w.path.endsWith("entries:write")));
});

test("options: dry run by default; apply and verify need an operator address", () => {
  assert.deepEqual(parse([]), { project: P, email: null, days: 7, apply: false, verifyAlert: false, verifyThreshold: false, cleanup: false, threshold: 5, confirm: null, canaryConnections: [] });
  assert.deepEqual(parse(["--confirm", "aa11bb22", "cc33dd44"]).confirm, ["aa11bb22", "cc33dd44"]);
  assert.deepEqual(parse(["--confirm"]).confirm, []);
  assert.throws(() => parse(["--verify-alert", "--email", "a@b.c", "--confirm", "x"]), /separate runs/);
  assert.equal(parse(["--apply", "--email", "ops@example.com", "--canary-connection", "conn-canary"]).apply, true);
  assert.deepEqual(parse(["--apply", "--email", "a@b.c", "--canary-connection", "conn-a", "--canary-connection", "conn-b"]).canaryConnections, ["conn-a", "conn-b"]);
  assert.throws(() => parse(["--apply", "--email", "ops@example.com"]), /--canary-connection is required/);
  assert.throws(() => parse(["--verify-alert", "--email", "ops@example.com"]), /--canary-connection is required/);
  assert.throws(() => parse(["--canary-connection", "alice@example.com"]), /must be a connection id/);
  assert.throws(() => parse(["--apply"]), /--email is required/);
  assert.throws(() => parse(["--verify-alert", "--email", "nope"]), /must be an address/);
  assert.throws(() => parse(["--apply", "--verify-alert", "--email", "a@b.c"]), /separate runs/);
  // --verify-threshold: dry unless --apply; no canary needed; --cleanup needs no address.
  assert.deepEqual(parse(["--verify-threshold", "--email", "a@b.c"]), { ...parse([]), email: "a@b.c", verifyThreshold: true });
  assert.equal(parse(["--verify-threshold", "--apply", "--email", "a@b.c", "--threshold", "3"]).threshold, 3);
  assert.equal(parse(["--verify-threshold", "--cleanup", "--apply"]).cleanup, true);
  assert.throws(() => parse(["--verify-threshold"]), /--email is required with --verify-threshold/);
  assert.throws(() => parse(["--cleanup"]), /goes with --verify-threshold/);
  assert.throws(() => parse(["--verify-threshold", "--verify-alert", "--email", "a@b.c"]), /separate runs/);
  assert.throws(() => parse(["--verify-threshold", "--email", "a@b.c", "--threshold", "0"]), /--threshold/);
  assert.throws(() => parse(["--days", "0"]), /positive/);
  assert.throws(() => parse(["--wat"]), /unknown/);
});

// System preview signing limits (plan system-preview-rate-limit, design point 4).

test("the evaluator reads filters as Logging does", () => {
  const e = entry("broker", { event: "execute", outcome: "denied", reason: "authorization-denied:not-granted" });
  assert.equal(matches("jsonPayload.event=\"execute\" AND resource.labels.service_name=(\"policy\" OR \"broker\")", e), true);
  assert.equal(matches("jsonPayload.reason=~\"^authorization-denied:\"", e), true);
  assert.equal(matches("NOT jsonPayload.reason=~\"^authorization-denied:\"", e), false);
  // OR binds tighter than AND.
  assert.equal(matches("jsonPayload.event=\"x\" AND jsonPayload.outcome=\"denied\" OR jsonPayload.event=\"execute\"", e), false);
  assert.equal(matches("jsonPayload.missing=\"\"", e), false);
});

test("the limiter metric counts the three named sources, and nothing else", () => {
  const limited = spec("system_preview_limited");
  for (const src of SYSTEM_PREVIEW_LIMIT_SOURCES) {
    assert.ok(limited.filter.includes(`resource.labels.service_name="${src.service}" AND jsonPayload.event="${src.event}" AND jsonPayload.reason="${src.reason}"`), src.service);
  }
  for (const id of ["policyRateLimited", "brokerExhausted", "api429"]) {
    assert.equal(matches(limited.filter, records[id]), true, id);
    assert.equal(matches(limited.base, records[id]), true, `${id} (base)`);
  }
  const unrelated = {
    signature: records.systemSignature,
    otherPolicyDenial: entry("policy", { event: "mint", ...SYS, outcome: "denied", reason: "not-granted", category: "permission" }),
    otherBrokerDenial: entry("broker", { event: "execute", ...SYS, provenance: "system", outcome: "denied", reason: "token-replayed", category: "conflict" }),
    // A reason from the wrong source: Broker's session limit is not Policy's.
    sessionExhaustedAtPolicy: entry("policy", { event: "mint", ...SYS, outcome: "denied", reason: "session-exhausted", category: "unavailable" }),
    rateLimitedAtBroker: entry("broker", { event: "execute", ...SYS, outcome: "denied", reason: "rate-limited", category: "unavailable" }),
    otherApiEvent: entry("api", { event: "admission", outcome: "denied", reason: "rate-limited", category: "unavailable" }),
    allowedApi: entry("api", { event: "system-signing-limit", outcome: "allowed" }),
    l0176: entry("l0176", { event: "mint", outcome: "denied", reason: "rate-limited" }),
    testRecord: { logName: `projects/${P}/logs/${TEST_LOG}`, resource: { type: "global", labels: { project_id: P } }, jsonPayload: { logName: "security_audit", event: "monitoring-test", outcome: "denied", reason: "rate-limited", category: "unavailable" } },
    otherLog: { ...records.policyRateLimited, jsonPayload: { ...records.policyRateLimited.jsonPayload, logName: "requests" } },
  };
  for (const [id, e] of Object.entries(unrelated)) assert.equal(matches(limited.filter, e), false, id);
});

test("the limiter metric is labelled by the refusing service, from the resource", async () => {
  const g = fakeGoogle();
  await apply({ api: g.api, project: P });
  const m = g.metrics.get("security_audit/system_preview_limited");
  assert.deepEqual(m.labelExtractors, { source: "EXTRACT(resource.labels.service_name)" });
  assert.deepEqual(m.metricDescriptor.labels, [{ key: "source", valueType: "STRING" }]);
  const s = g.metrics.get("security_audit/system_signings");
  assert.deepEqual(s.labelExtractors, { outcome: "EXTRACT(jsonPayload.outcome)" });
});

test("the signings metric counts Broker executions under a system session, not a connection's or a publication's", () => {
  const signings = spec("system_signings");
  assert.match(signings.filter, /service_name="broker" AND jsonPayload\.event="execute" AND jsonPayload\.provenance="system"$/);
  assert.equal(matches(signings.filter, records.systemSignature), true);
  // A refusal under a system session is an attempt, counted by outcome.
  assert.equal(matches(signings.filter, records.brokerExhausted), true);
  assert.equal(matches(signings.filter, records.connectionSignature), false);
  assert.equal(matches(signings.filter, records.publicationSignature), false);
  // The step record of the same signature is not a second one.
  assert.equal(matches(signings.filter, records.systemStep), false);
  assert.equal(matches(signings.filter, records.policyRateLimited), false);
});

test("the global rate-limited alert matches Policy's mint refusal only", () => {
  const alert = alertSpecs(P).find(a => a.id === "rate-limited");
  assert.equal(matches(alert.filter, records.policyRateLimited), true);
  for (const id of ["brokerExhausted", "api429", "systemSignature"]) assert.equal(matches(alert.filter, records[id]), false, id);
  assert.equal(desiredPolicy(alert, "ch").conditions[0].conditionMatchedLog.filter, alert.filter);
});

const signingsAlert = () => alertSpecs(P).find(a => a.id === "system-signings");

test("the hourly signings alert is a metric-threshold condition, summed over an hour", () => {
  const policy = desiredPolicy(signingsAlert(), "projects/p/notificationChannels/1");
  assert.deepEqual(policy.conditions, [{
    displayName: "Security audit: system signings over 600 in an hour",
    conditionThreshold: {
      filter: "metric.type=\"logging.googleapis.com/user/security_audit/system_signings\" AND resource.type=\"cloud_run_revision\"",
      aggregations: [{ alignmentPeriod: "3600s", perSeriesAligner: "ALIGN_SUM", crossSeriesReducer: "REDUCE_SUM" }],
      comparison: "COMPARISON_GT",
      thresholdValue: 600,
      duration: "0s",
      trigger: { count: 1 },
    },
  }]);
  // Monitoring takes notificationRateLimit only on log-match policies.
  assert.deepEqual(policy.alertStrategy, { autoClose: "1800s" });
  assert.equal(policy.combiner, "OR");
  assert.deepEqual(policy.notificationChannels, ["projects/p/notificationChannels/1"]);
});

test("a threshold policy's notification text uses metric variables, never log labels", () => {
  const doc = desiredPolicy(signingsAlert(), "ch").documentation.content;
  assert.doesNotMatch(doc, /\$\{log\./);
  assert.doesNotMatch(doc, /Nonce:/);
  assert.match(doc, /\$\{metric\.type\}/);
  assert.match(doc, /\$\{condition\.display_name\}/);
  assert.match(doc, /over 1 h/);
  assert.match(doc, /above 600/);
  assert.match(doc, /observed value/);
  for (const v of doc.match(/\$\{[^}]+\}/g)) assert.match(v, /^\$\{(metric|condition|policy)\./, v);
  // The log-match policies keep theirs.
  assert.match(desiredPolicy(alertSpecs(P)[0], "ch").documentation.content, /\$\{log\.extracted_label\.nonce\}/);
});

test("every compared field of a threshold condition is detected as a change", () => {
  const desired = desiredPolicy(signingsAlert(), "ch");
  // As Monitoring returns it: server names and a double threshold.
  const live = structuredClone(desired);
  live.name = "projects/p/alertPolicies/9";
  live.conditions[0].name = "projects/p/alertPolicies/9/conditions/1";
  live.conditions[0].conditionThreshold.thresholdValue = 600.0;
  live.creationRecord = { mutateTime: "t" };
  assert.equal(policyChanged(live, desired), false);
  const changes = {
    threshold: t => { t.thresholdValue = 500; },
    comparison: t => { t.comparison = "COMPARISON_GE"; },
    window: t => { t.aggregations[0].alignmentPeriod = "1800s"; },
    aligner: t => { t.aggregations[0].perSeriesAligner = "ALIGN_RATE"; },
    reducer: t => { t.aggregations[0].crossSeriesReducer = "REDUCE_MAX"; },
    grouping: t => { t.aggregations[0].groupByFields = ["metric.label.outcome"]; },
    duration: t => { t.duration = "300s"; },
    trigger: t => { t.trigger = { count: 2 }; },
    filter: t => { t.filter = "metric.type=\"logging.googleapis.com/user/security_audit/other\""; },
  };
  for (const [field, change] of Object.entries(changes)) {
    const drifted = structuredClone(live);
    change(drifted.conditions[0].conditionThreshold);
    assert.equal(policyChanged(drifted, desired), true, field);
  }
  const doc = structuredClone(live);
  doc.documentation.content += " edited";
  assert.equal(policyChanged(doc, desired), true, "documentation");
  // A log-match condition where a threshold belongs.
  const kind = structuredClone(live);
  kind.conditions[0] = desiredPolicy(alertSpecs(P)[0], "ch").conditions[0];
  kind.conditions[0].displayName = desired.conditions[0].displayName;
  assert.equal(policyChanged(kind, desired), true, "condition kind");
});

test("a changed threshold is applied, not reported unchanged", async () => {
  const g = fakeGoogle();
  await apply({ api: g.api, project: P, email: "ops@example.com" });
  const live = g.policies.find(p => p.displayName === signingsAlert().displayName);
  assert.equal(live.conditions[0].conditionThreshold.thresholdValue, 600);
  live.conditions[0].conditionThreshold.thresholdValue = 900;
  const before = g.writes.length;
  const steps = await apply({ api: g.api, project: P, email: "ops@example.com" });
  assert.deepEqual(steps.filter(s => s.action !== "unchanged").map(s => `${s.action} ${s.name}`), [`update ${signingsAlert().displayName}`]);
  assert.deepEqual(g.writes.slice(before).map(w => w.method), ["PATCH"]);
  assert.equal(live.conditions[0].conditionThreshold.thresholdValue, 900);
  assert.equal(g.policies.find(p => p.displayName === signingsAlert().displayName).conditions[0].conditionThreshold.thresholdValue, 600);
});

test("threshold conditions take other windows and comparisons", () => {
  const c = thresholdCondition({ metric: "security_audit/x", resourceType: "global", value: 5, period: "600s", comparison: "COMPARISON_GE", displayName: "x" });
  assert.equal(c.conditionThreshold.filter, "metric.type=\"logging.googleapis.com/user/security_audit/x\" AND resource.type=\"global\"");
  assert.deepEqual(c.conditionThreshold.aggregations, [{ alignmentPeriod: "600s", perSeriesAligner: "ALIGN_SUM", crossSeriesReducer: "REDUCE_SUM" }]);
  assert.equal(c.conditionThreshold.comparison, "COMPARISON_GE");
});

const withChannel = () => {
  const g = fakeGoogle();
  g.channels.push({ name: `projects/${P}/notificationChannels/77`, type: "email", labels: { email_address: "ops@example.com" } });
  return g;
};

test("verify-threshold's dry run makes the scratch metric, policy and nonce, and writes nothing", async () => {
  const g = withChannel();
  const run = await verifyThreshold({ api: g.api, project: P, email: "ops@example.com", nonce: "c0ffee01", runId: "run00001" });
  assert.equal(run.applied, false);
  assert.equal(run.nonce, "c0ffee01");
  assert.equal(g.writes.length, 0);
  assert.equal(g.timeSeries.length, 0);
  const { metric, policy } = run.scratch;
  assert.equal(metric.name, `${SCRATCH_METRIC_PREFIX}run00001`);
  // Test records only, so no real metric or alert reads them.
  assert.ok(metric.filter.startsWith(`logName="projects/${P}/logs/${TEST_LOG}" AND jsonPayload.logName="security_audit" AND jsonPayload.event="monitoring-test"`));
  assert.ok(!metric.name.includes("c0ffee01") && !metric.filter.includes("c0ffee01"), "the email shows the metric type; it must not give the nonce away");
  assert.equal(policy.displayName, SCRATCH_POLICY);
  assert.deepEqual(policy.notificationChannels, [`projects/${P}/notificationChannels/77`]);
  // Shaped like the real alert, with a low threshold.
  const real = desiredPolicy(signingsAlert(), "ch").conditions[0].conditionThreshold;
  const t = policy.conditions[0].conditionThreshold;
  assert.deepEqual(t.aggregations, real.aggregations);
  assert.equal(t.comparison, real.comparison);
  assert.equal(t.duration, real.duration);
  assert.equal(t.thresholdValue, 5);
  assert.equal(t.filter, `metric.type="logging.googleapis.com/user/${SCRATCH_METRIC_PREFIX}run00001" AND resource.type="global"`);
  // The nonce, literally, in the documentation; no log labels.
  assert.match(policy.documentation.content, /\n\nNonce: c0ffee01$/);
  assert.doesNotMatch(policy.documentation.content, /\$\{log\./);
  assert.deepEqual(policy.alertStrategy, { autoClose: "1800s" });
  assert.equal(run.steps.length, 4);
  assert.match(run.steps[1], /Nonce: c0ffee01/);
});

test("verify-threshold's records match the scratch metric and no alert or real metric", () => {
  return verifyThreshold({ api: withChannel().api, project: P, email: "ops@example.com", nonce: "c0ffee01", runId: "run00001" }).then(({ scratch }) => {
    const e = { logName: `projects/${P}/logs/${TEST_LOG}`, resource: { type: "global", labels: { project_id: P } }, ...scratch.record("t") };
    assert.equal(matches(scratch.metric.filter, e), true);
    for (const a of alertSpecs(P).filter(x => x.filter)) assert.equal(matches(a.filter, e), false, a.id);
    for (const m of metricSpecs(P)) assert.equal(matches(m.filter, e), false, m.id);
    // Another run's records are not this run's.
    assert.equal(matches(scratch.metric.filter, { ...e, jsonPayload: { ...e.jsonPayload, run: "run00002" } }), false);
  });
});

test("verify-threshold applied: metric first, the threshold reached and held, then crossed", async () => {
  const g = withChannel();
  const waits = [];
  const run = await verifyThreshold({
    api: g.api,
    project: P,
    email: "ops@example.com",
    apply: true,
    nonce: "c0ffee01",
    runId: "run00001",
    wait: async ms => { waits.push(ms); },
    settleMs: 1,
    holdMs: 2,
    pollMs: 3,
  });
  assert.equal(run.applied, true);
  assert.deepEqual(g.writes.map(w => `${w.method} ${w.path}`), [
    `POST /v2/projects/${P}/metrics`,
    `POST /v3/projects/${P}/alertPolicies`,
    "POST /v2/entries:write",
    "POST /v2/entries:write",
  ]);
  const [, created, under, over] = g.writes;
  assert.match(created.body.documentation.content, /Nonce: c0ffee01$/);
  assert.equal(under.body.entries.length, 5);
  assert.equal(over.body.entries.length, 1);
  assert.deepEqual(waits, [1, 2]);
  // Queried as the condition aggregates.
  assert.ok(g.timeSeries.every(q => q["aggregation.alignmentPeriod"] === "3600s" && q["aggregation.perSeriesAligner"] === "ALIGN_SUM" && q["aggregation.crossSeriesReducer"] === "REDUCE_SUM"));
  assert.ok(run.crossedAt);
});

test("verify-threshold refuses without the operator's channel, and stops when the metric isn't ingested", async () => {
  await assert.rejects(verifyThreshold({ api: fakeGoogle().api, project: P, email: "ops@example.com", apply: true }), /run --apply first/);
  const g = withChannel();
  const real = g.api;
  const blind = async (method, url, body) => (new URL(url).pathname.endsWith("/timeSeries") ? { status: 200, json: {} } : real(method, url, body));
  let clock = 0;
  await assert.rejects(verifyThreshold({
    api: blind,
    project: P,
    email: "ops@example.com",
    apply: true,
    nonce: "c0ffee01",
    runId: "run00001",
    now: () => new Date(Date.UTC(2026, 9, 15) + clock),
    wait: async ms => { clock += ms; },
    settleMs: 1,
    holdMs: 1,
    pollMs: 60000,
    ingestMs: 300000,
  }), /shows 0, not 5.*not ingested/);
  // Nothing crossed.
  assert.equal(g.writes.filter(w => w.path.endsWith("entries:write")).length, 1);
});

test("cleanup removes every scratch metric and the scratch policy, only with apply", async () => {
  const g = withChannel();
  await apply({ api: g.api, project: P, email: "ops@example.com" });
  const real = g.metrics.size;
  const noWait = { wait: async () => {}, settleMs: 0, holdMs: 0, pollMs: 0 };
  await verifyThreshold({ api: g.api, project: P, email: "ops@example.com", apply: true, nonce: "aaaa0001", runId: "run00001", ...noWait });
  await verifyThreshold({ api: g.api, project: P, email: "ops@example.com", apply: true, nonce: "aaaa0002", runId: "run00002", ...noWait });
  // The second run updated the one scratch policy, with its own nonce.
  assert.equal(g.policies.filter(p => p.displayName === SCRATCH_POLICY).length, 1);
  assert.match(g.policies.find(p => p.displayName === SCRATCH_POLICY).documentation.content, /Nonce: aaaa0002$/);
  const before = g.writes.length;
  const dry = await cleanupThreshold({ api: g.api, project: P });
  assert.equal(dry.applied, false);
  assert.equal(dry.steps.length, 3);
  assert.equal(g.writes.length, before);
  await cleanupThreshold({ api: g.api, project: P, apply: true });
  assert.deepEqual(g.writes.slice(before).map(w => w.method), ["DELETE", "DELETE", "DELETE"]);
  assert.match(g.writes[before].path, /alertPolicies/);
  assert.equal(g.metrics.size, real);
  assert.ok(![...g.metrics.keys()].some(n => n.startsWith(SCRATCH_METRIC_PREFIX)));
  assert.equal(g.policies.filter(p => p.displayName === SCRATCH_POLICY).length, 0);
  assert.equal(g.policies.length, alertSpecs(P).length);
});
