// Monitoring for the security audit (capability plan W3, spec AUDIT-01):
// log-based metrics that count each kind of failure once, two log-match alert
// policies (authorization outages, uncertain writes) with an email channel,
// and a check that an alert's email really arrives. The Google APIs and the
// clock are injected so the operator sequence is tested
// (scripts/test/monitoring.test.js). See scripts/monitoring.js for usage.
//
// Every service writes one JSON line per decision on stdout; in Cloud Logging
// that is log run.googleapis.com/stdout with jsonPayload.logName="security_audit"
// (confirmed on deployed entries, 2026-10-06).

import { randomBytes } from "node:crypto";

/* eslint-disable camelcase -- Cloud Monitoring and Logging label keys are snake_case */

export const TEST_LOG = "security_audit_test";
const LOGGING = "https://logging.googleapis.com/v2";
const MONITORING = "https://monitoring.googleapis.com/v3";

const selector = project => `logName="projects/${project}/logs/run.googleapis.com%2Fstdout" AND jsonPayload.logName="security_audit"`;
const service = name => `resource.type="cloud_run_revision" AND resource.labels.service_name="${name}"`;
const events = names => names.length === 1 ? `jsonPayload.event="${names[0]}"` : `jsonPayload.event=(${names.map(n => `"${n}"`).join(" OR ")})`;

// One count per failure, defined by the record that reports it.
//   base     the records a metric is drawn from (selector, service, events);
//            it must match deployed entries, or the filter is wrong
//   match    what makes one of them count
//   expected the canary produces these, so the full filter must match too
export const metricSpecs = project => {
  const from = (svc, names) => `${selector(project)} AND ${service(svc)} AND ${events(names)}`;
  return [
    {
      id: "policy_denials",
      labels: ["event", "reason"],
      expected: true,
      description: "Policy's refusals, by event and reason.",
      base: `${selector(project)} AND ${service("policy")}`,
      match: "jsonPayload.outcome=\"denied\"",
    },
    {
      // A Broker refusal that relays Policy's (authorization-denied:<reason>)
      // is already counted as a Policy denial.
      id: "broker_local_refusals",
      labels: ["event", "reason"],
      expected: true,
      description: "Broker's own refusals, which Policy never saw (Policy's relayed denials excluded).",
      base: from("broker", ["execute", "secret"]),
      match: "jsonPayload.outcome=\"denied\" AND NOT jsonPayload.reason=~\"^authorization-denied:\"",
    },
    {
      id: "authorization_outages",
      labels: ["outcome"],
      expected: false,
      description: "Broker writes stopped because Policy could not be asked (authorization-unavailable).",
      base: from("broker", ["execute"]),
      match: "jsonPayload.reason=\"authorization-unavailable\"",
    },
    {
      id: "gateway_policy_unavailable",
      labels: ["event"],
      expected: false,
      description: "Gateway requests through a connection or publication refused because Policy could not be reached.",
      base: from("api", ["gateway-invocation", "publication-read"]),
      match: "jsonPayload.reason=\"policy-unavailable\"",
    },
    {
      // Final records only: a replay of an uncertain write is a replay.
      id: "uncertain_writes",
      labels: ["fn"],
      expected: false,
      description: "Writes whose provider effect is unknown (Broker's final outcome uncertain).",
      base: from("broker", ["execute"]),
      match: "jsonPayload.outcome=\"uncertain\"",
    },
    {
      id: "partial_writes",
      labels: ["fn", "reason"],
      expected: false,
      description: "Writes that stopped after some steps (Broker's final outcome partial).",
      base: from("broker", ["execute"]),
      match: "jsonPayload.outcome=\"partial\"",
    },
    {
      // Alert on `unavailable`; `conflict` includes a same-key retry whose
      // output differs from the stored artifact (kept; not an outage).
      id: "artifact_failures",
      labels: ["category", "reason"],
      expected: false,
      description: "Compile results through a connection whose artifact was not stored, by category.",
      base: from("api", ["artifact"]),
      match: "jsonPayload.outcome=\"failed\"",
    },
    {
      id: "receipt_replays",
      labels: ["reason"],
      expected: true,
      description: "Broker answers from a recorded outcome (never a new effect).",
      base: from("broker", ["execute"]),
      match: "jsonPayload.outcome=\"replayed\"",
    },
  ].map(spec => ({ ...spec, name: `security_audit/${spec.id}`, filter: `${spec.base} AND ${spec.match}` }));
};

export const desiredMetric = spec => ({
  name: spec.name,
  description: spec.description,
  filter: spec.filter,
  labelExtractors: Object.fromEntries(spec.labels.map(label => [label, `EXTRACT(jsonPayload.${label})`])),
  metricDescriptor: {
    metricKind: "DELTA",
    valueType: "INT64",
    labels: spec.labels.map(key => ({ key, valueType: "STRING" })),
  },
});

// Test records, written by --verify-alert: the alert conditions match them,
// the metrics never do.
const testRecords = project => `logName="projects/${project}/logs/${TEST_LOG}" AND jsonPayload.logName="security_audit" AND jsonPayload.event="monitoring-test"`;

export const alertSpecs = project => {
  const specs = Object.fromEntries(metricSpecs(project).map(s => [s.id, s]));
  return [
    {
      id: "outage",
      displayName: "Security audit: authorization outage",
      filter: `(${specs.authorization_outages.filter}) OR (${specs.gateway_policy_unavailable.filter}) OR (${testRecords(project)} AND jsonPayload.reason="authorization-unavailable")`,
      test: { outcome: "failed", reason: "authorization-unavailable" },
      content: "Policy could not be asked: a Broker write stopped (`authorization-unavailable`) or the gateway refused a request (`policy-unavailable`). Check Policy's health and recent releases; see docs/protected-execution.md, Monitoring.",
    },
    {
      id: "uncertain",
      displayName: "Security audit: uncertain write",
      filter: `(${specs.uncertain_writes.filter}) OR (${testRecords(project)} AND jsonPayload.outcome="uncertain")`,
      test: { outcome: "uncertain" },
      content: "A protected write's provider effect is unknown. Reconcile it before anyone retries with a new operation; see docs/protected-execution.md, Monitoring.",
    },
  ];
};

export const desiredPolicy = (spec, channel) => ({
  displayName: spec.displayName,
  combiner: "OR",
  enabled: true,
  notificationChannels: [channel],
  documentation: {
    mimeType: "text/markdown",
    content: `${spec.content}\n\nService: \${log.extracted_label.service}; outcome: \${log.extracted_label.outcome}; reason: \${log.extracted_label.reason}. Nonce: \${log.extracted_label.nonce}`,
  },
  conditions: [{
    displayName: spec.displayName,
    conditionMatchedLog: {
      filter: spec.filter,
      labelExtractors: {
        service: "EXTRACT(resource.labels.service_name)",
        outcome: "EXTRACT(jsonPayload.outcome)",
        reason: "EXTRACT(jsonPayload.reason)",
        nonce: "EXTRACT(jsonPayload.nonce)",
      },
    },
  }],
  alertStrategy: { notificationRateLimit: { period: "300s" }, autoClose: "1800s" },
});

// What the script manages, so a server-added field never reads as a change.
const metricView = m => m && {
  description: m.description,
  filter: m.filter,
  labelExtractors: m.labelExtractors ?? {},
  labels: (m.metricDescriptor?.labels ?? []).map(l => l.key).sort(),
};
const policyView = p => p && {
  combiner: p.combiner,
  enabled: p.enabled !== false,
  notificationChannels: p.notificationChannels ?? [],
  documentation: p.documentation?.content,
  conditions: (p.conditions ?? []).map(c => ({ displayName: c.displayName, filter: c.conditionMatchedLog?.filter, labelExtractors: c.conditionMatchedLog?.labelExtractors ?? {} })),
  rateLimit: p.alertStrategy?.notificationRateLimit?.period,
  autoClose: p.alertStrategy?.autoClose,
};
const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const sortKeys = v => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v;

const ok = (res, what) => {
  if (res.status < 200 || res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.json)?.slice(0, 300)}`);
  return res.json;
};

// Entries matching a filter since `since`, up to `cap` (enough to know).
export const CAP = 50;
const countEntries = async (api, project, filter, since, cap = CAP) => {
  const res = ok(await api("POST", `${LOGGING}/entries:list`, {
    resourceNames: [`projects/${project}`], filter: `${filter} AND timestamp>="${since}"`, pageSize: cap, orderBy: "timestamp desc",
  }), "entries:list");
  return (res.entries ?? []).length;
};

// The filter check (plan G): every metric's base must match deployed entries,
// and every metric the canary produces must match on its own.
export const checkFilters = async ({ api, project, since }) => {
  const results = [];
  for (const spec of metricSpecs(project)) {
    const base = await countEntries(api, project, spec.base, since);
    const matched = await countEntries(api, project, spec.filter, since);
    const problem = base === 0 ? "its records match no deployed entries" : spec.expected && matched === 0 ? "the canary's records of this kind match nothing" : null;
    results.push({ name: spec.name, base, matched, problem });
  }
  return results;
};

const findChannel = async (api, project, email) => {
  const res = ok(await api("GET", `${MONITORING}/projects/${project}/notificationChannels?filter=${encodeURIComponent("type=\"email\"")}`), "notificationChannels.list");
  return (res.notificationChannels ?? []).find(c => c.labels?.email_address === email) ?? null;
};

const findPolicy = async (api, project, displayName) => {
  const res = ok(await api("GET", `${MONITORING}/projects/${project}/alertPolicies?filter=${encodeURIComponent(`display_name="${displayName}"`)}`), "alertPolicies.list");
  const found = res.alertPolicies ?? [];
  if (found.length > 1) throw new Error(`${found.length} alert policies are named "${displayName}"; remove the extras`);
  return found[0] ?? null;
};

const metricUrl = (project, name) => `${LOGGING}/projects/${project}/metrics/${encodeURIComponent(name)}`;

// The changes --apply would make: create, update or unchanged, per resource.
export const plan = async ({ api, project, email }) => {
  const steps = [];
  for (const spec of metricSpecs(project)) {
    const res = await api("GET", metricUrl(project, spec.name));
    const existing = res.status === 404 ? null : ok(res, `metrics.get ${spec.name}`);
    const desired = desiredMetric(spec);
    steps.push({ kind: "metric", name: spec.name, action: !existing ? "create" : same(metricView(existing), metricView(desired)) ? "unchanged" : "update", desired });
  }
  if (!email) return { steps, channel: null };
  const channel = await findChannel(api, project, email);
  steps.push({ kind: "channel", name: email, action: channel ? "unchanged" : "create", existing: channel });
  for (const spec of alertSpecs(project)) {
    const existing = await findPolicy(api, project, spec.displayName);
    const desired = desiredPolicy(spec, channel?.name ?? "(new channel)");
    const action = !existing ? "create" : channel && same(policyView(existing), policyView(desired)) ? "unchanged" : "update";
    steps.push({ kind: "policy", name: spec.displayName, action, existing, spec });
  }
  return { steps, channel };
};

export const apply = async ({ api, project, email, log = () => {} }) => {
  const { steps } = await plan({ api, project, email });
  let channelName = steps.find(s => s.kind === "channel")?.existing?.name;
  for (const step of steps) {
    if (step.action === "unchanged") continue;
    if (step.kind === "metric") {
      if (step.action === "create") ok(await api("POST", `${LOGGING}/projects/${project}/metrics`, step.desired), `metrics.create ${step.name}`);
      else ok(await api("PUT", metricUrl(project, step.name), step.desired), `metrics.update ${step.name}`);
    }
    if (step.kind === "channel") {
      const created = ok(await api("POST", `${MONITORING}/projects/${project}/notificationChannels`, {
        type: "email", displayName: "Security audit operator", labels: { email_address: email },
      }), "notificationChannels.create");
      channelName = created.name;
    }
    if (step.kind === "policy") {
      const desired = desiredPolicy(step.spec, channelName);
      if (step.action === "create") ok(await api("POST", `${MONITORING}/projects/${project}/alertPolicies`, desired), `alertPolicies.create ${step.name}`);
      else {
        const mask = "displayName,combiner,enabled,notificationChannels,documentation,conditions,alertStrategy";
        ok(await api("PATCH", `${MONITORING}/${step.existing.name}?updateMask=${mask}`, desired), `alertPolicies.patch ${step.name}`);
      }
    }
    log(`  ${step.action} ${step.kind} ${step.name}`);
  }
  return steps;
};

// Alert delivery (plan G): an incident firing doesn't prove the email
// arrived. Two runs, so neither needs a prompt: writeTestRecords writes, for
// each alert, one test record that its own condition matches, carrying a
// nonce; once the emails arrive, confirmDelivery matches the nonces the
// operator copied from them.
export const writeTestRecords = async ({ api, project, email, now = () => new Date(), nonce = () => randomBytes(4).toString("hex"), log = () => {} }) => {
  const { steps } = await plan({ api, project, email });
  const pending = steps.filter(s => s.action !== "unchanged").map(s => `${s.kind} ${s.name}`);
  if (pending.length) throw new Error(`monitoring is not applied (${pending.join(", ")}); run --apply first`);
  const written = [];
  for (const spec of alertSpecs(project)) {
    const value = nonce();
    const writtenAt = now().toISOString();
    ok(await api("POST", `${LOGGING}/entries:write`, {
      logName: `projects/${project}/logs/${TEST_LOG}`,
      resource: { type: "global", labels: { project_id: project } },
      entries: [{ jsonPayload: { logName: "security_audit", event: "monitoring-test", ...spec.test, nonce: value, at: writtenAt } }],
    }), "entries:write");
    log(`Wrote a test record for "${spec.displayName}".`);
    written.push({ alert: spec.displayName, nonce: value, writtenAt });
  }
  return written;
};

// One result per alert written: delivered when its nonce is among those typed
// (in any order). A nonce that matches no alert is reported, not ignored.
export const confirmDelivery = (written, typed, now = () => new Date()) => {
  const given = typed.map(t => String(t).trim().toLowerCase()).filter(Boolean);
  const results = written.map(w => ({ alert: w.alert, writtenAt: w.writtenAt, confirmedAt: now().toISOString(), delivered: given.includes(w.nonce) }));
  const unknown = given.filter(g => !written.some(w => w.nonce === g));
  return { results, unknown };
};
