import test from "node:test";
import assert from "node:assert/strict";
import { TEST_LOG, alertSpecs, apply, checkFilters, metricSpecs, plan, verifyAlerts } from "../lib/monitoring.js";
import { parse } from "../monitoring.js";

/* eslint-disable camelcase -- Cloud Monitoring and Logging label keys are snake_case */

const P = "graffiticode";

// Just enough of Cloud Logging and Cloud Monitoring: metrics, channels,
// alert policies, entry counts by filter, and every write.
const fakeGoogle = ({ count = () => 5 } = {}) => {
  const metrics = new Map();
  const channels = [];
  const policies = [];
  const writes = [];
  const listed = [];
  let ids = 0;
  const api = async (method, url, body) => {
    const u = new URL(url);
    if (method !== "GET" && !u.pathname.endsWith("/entries:list")) writes.push({ method, path: u.pathname, body });
    if (u.pathname.endsWith("/entries:list")) {
      listed.push(body.filter);
      return { status: 200, json: { entries: Array(Math.min(count(body.filter), body.pageSize)).fill({}) } };
    }
    if (u.pathname.endsWith("/entries:write")) return { status: 200, json: {} };
    const metric = u.pathname.match(/\/metrics\/(.+)$/);
    if (metric) {
      const name = decodeURIComponent(metric[1]);
      if (method === "GET") return metrics.has(name) ? { status: 200, json: structuredClone(metrics.get(name)) } : { status: 404, json: {} };
      if (method === "PUT") { metrics.set(name, structuredClone(body)); return { status: 200, json: body }; }
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
    if (policy && method === "PATCH") {
      const i = policies.findIndex(p => p.name === policy[1]);
      policies[i] = { ...policies[i], ...structuredClone(body), name: policy[1] };
      return { status: 200, json: policies[i] };
    }
    return { status: 500, json: { error: `unhandled ${method} ${u.pathname}` } };
  };
  return { api, metrics, channels, policies, writes, listed };
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
  assert.deepEqual(steps.map(s => s.kind), [...Array(metricSpecs(P).length).fill("metric"), "channel", "policy", "policy"]);
  assert.equal(g.writes.length, 0);
});

test("apply creates everything once, and a second apply changes nothing", async () => {
  const g = fakeGoogle();
  await apply({ api: g.api, project: P, email: "ops@example.com" });
  assert.equal(g.metrics.size, metricSpecs(P).length);
  assert.equal(g.channels.length, 1);
  assert.equal(g.policies.length, 2);
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

test("alert verification writes a test record per alert and confirms delivery by nonce", async () => {
  const g = fakeGoogle();
  await apply({ api: g.api, project: P, email: "ops@example.com" });
  const before = g.writes.length;
  const nonces = ["n0nce001", "n0nce002"];
  const asked = [];
  const results = await verifyAlerts({
    api: g.api,
    project: P,
    email: "ops@example.com",
    nonce: () => nonces[asked.length],
    prompt: async q => { asked.push(q); return asked.length === 1 ? " n0nce001 \n" : ""; },
  });
  const written = g.writes.slice(before);
  assert.deepEqual(written.map(w => w.path), ["/v2/entries:write", "/v2/entries:write"]);
  assert.deepEqual(written.map(w => w.body.logName), Array(2).fill(`projects/${P}/logs/${TEST_LOG}`));
  assert.deepEqual(written.map(w => w.body.entries[0].jsonPayload).map(({ at, ...p }) => p), [
    { logName: "security_audit", event: "monitoring-test", outcome: "failed", reason: "authorization-unavailable", nonce: "n0nce001" },
    { logName: "security_audit", event: "monitoring-test", outcome: "uncertain", nonce: "n0nce002" },
  ]);
  assert.deepEqual(results.map(r => [r.alert, r.delivered]), [["Security audit: authorization outage", true], ["Security audit: uncertain write", false]]);
});

test("alert verification refuses until monitoring is applied as specified", async () => {
  const g = fakeGoogle();
  await assert.rejects(verifyAlerts({ api: g.api, project: P, email: "ops@example.com", prompt: async () => "" }), /not applied.*run --apply first/);
  await apply({ api: g.api, project: P, email: "ops@example.com" });
  g.policies[1].conditions[0].conditionMatchedLog.filter = "drifted";
  await assert.rejects(verifyAlerts({ api: g.api, project: P, email: "ops@example.com", prompt: async () => "" }), /policy Security audit: uncertain write/);
  assert.ok(!g.writes.some(w => w.path.endsWith("entries:write")));
});

test("options: dry run by default; apply and verify need an operator address", () => {
  assert.deepEqual(parse([]), { project: P, email: null, days: 7, apply: false, verifyAlert: false });
  assert.equal(parse(["--apply", "--email", "ops@example.com"]).apply, true);
  assert.throws(() => parse(["--apply"]), /--email is required/);
  assert.throws(() => parse(["--verify-alert", "--email", "nope"]), /must be an address/);
  assert.throws(() => parse(["--apply", "--verify-alert", "--email", "a@b.c"]), /separate runs/);
  assert.throws(() => parse(["--days", "0"]), /positive/);
  assert.throws(() => parse(["--wat"]), /unknown/);
});
