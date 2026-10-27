// Monitoring for the security audit (capability plan W3, spec AUDIT-01):
// log-based metrics that count each kind of failure once, log-match alert
// policies (authorization outages, uncertain and partial writes, artifact
// storage outages, permission denials and plan/contract refusals outside the
// canary, the global system preview signing limit), a metric-threshold
// policy (system signings per hour) with an email channel, and checks that an
// alert's email really arrives: one test record per log-match alert, and a
// scratch metric and threshold policy for the metric path. The Google APIs
// and the clock are injected so the operator sequence is tested
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
// The scheduled canary job's stdout (Cloud Run job `canary`).
const CANARY_JOB = project => `logName="projects/${project}/logs/run.googleapis.com%2Fstdout" AND resource.type="cloud_run_job" AND resource.labels.job_name="canary"`;
const service = name => `resource.type="cloud_run_revision" AND resource.labels.service_name="${name}"`;
const events = names => names.length === 1 ? `jsonPayload.event="${names[0]}"` : `jsonPayload.event=(${names.map(n => `"${n}"`).join(" OR ")})`;

// The refusals of system preview signing (plan system-preview-rate-limit,
// design point 4), each named by the service, event and reason that write it:
//   policy  the per-instance mint bucket refuses a system-session execution token
//   broker  a system session has used all its signing slots
//   api     the per-client limit refuses a signing stage (a 429)
// The service is the Cloud Run service (resource.labels.service_name), as in
// every other metric: the audit validators keep only known fields, so a
// `service` field in the record itself would not reach the log.
export const SYSTEM_PREVIEW_LIMIT_SOURCES = Object.freeze([
  Object.freeze({ service: "policy", event: "mint", reason: "rate-limited" }),
  Object.freeze({ service: "broker", event: "execute", reason: "session-exhausted" }),
  Object.freeze({ service: "api", event: "system-signing-limit", reason: "rate-limited" }),
]);

// The plan and contract refusals (contract v2, W4) that never happen in a
// supported workflow: each means the gateway and Policy disagree.
export const CONTRACT_REFUSALS = Object.freeze([
  "plan-required", "plan-mismatch", "plan-binding-mismatch", "invocation-incompatible", "contract-version-unsupported",
]);

const or = clauses => clauses.length === 1 ? clauses[0] : `(${clauses.map(c => `(${c})`).join(" OR ")})`;
const limitSource = ({ service: svc, event }) => `resource.labels.service_name="${svc}" AND jsonPayload.event="${event}"`;

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
      // The gateway's own refusals: chain admission and its invocation and
      // publication checks (W4). Policy's decisions it relays are also counted
      // in policy_denials.
      id: "api_denials",
      labels: ["event", "reason", "category"],
      expected: true,
      description: "The gateway's refusals (admission, invocations, publication reads), by event, reason and category.",
      base: `${selector(project)} AND ${service("api")}`,
      match: "jsonPayload.outcome=\"denied\"",
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
      // AUDIT-01 requires a category on every failure; the audit records one it
      // can't determine as "invalid". Expected to stay at zero.
      id: "uncategorized_failures",
      labels: ["event", "reason"],
      expected: false,
      description: "Failure records whose category couldn't be determined (category invalid): a reason missing from the failure table.",
      base: `${selector(project)} AND resource.type="cloud_run_revision" AND resource.labels.service_name=("policy" OR "broker" OR "api")`,
      match: "jsonPayload.category=\"invalid\"",
    },
    {
      // Broker's records of executions under a system preview session: the
      // execution token's provenance (`prv`, recorded as `provenance`) is
      // "system", which Broker re-checks against the system subject
      // (provenanceRefusal). A system session carries only signing functions
      // (systemPreviewFunctionsForLang), so these are signatures and refused
      // signing attempts, by outcome. `execute` only: the `execute-step`
      // record of the same signature is not counted again.
      id: "system_signings",
      labels: ["outcome"],
      expected: true,
      description: "Broker executions under a system preview session (provenance system): signatures and refused attempts, by outcome.",
      base: from("broker", ["execute"]),
      match: "jsonPayload.provenance=\"system\"",
    },
    {
      // Every refusal that limits system preview signing, by the service
      // that refused (Policy's mint bucket, Broker's session slots, api's
      // per-client limit).
      id: "system_preview_limited",
      labels: ["source"],
      extractors: { source: "EXTRACT(resource.labels.service_name)" },
      expected: false,
      description: "System preview signing refused by a limit, by source: Policy's mint bucket (rate-limited), Broker's session slots (session-exhausted), api's per-client limit (rate-limited).",
      base: `${selector(project)} AND resource.type="cloud_run_revision" AND resource.labels.service_name=("policy" OR "broker" OR "api") AND ${or(SYSTEM_PREVIEW_LIMIT_SOURCES.map(limitSource))}`,
      match: `jsonPayload.outcome="denied" AND ${or(SYSTEM_PREVIEW_LIMIT_SOURCES.map(src => `${limitSource(src)} AND jsonPayload.reason="${src.reason}"`))}`,
    },
    {
      // The scheduled canary's verdicts (P1 #2, B): its last line is "canary
      // passed (N checks)" or "canary FAILED (n of N checks)". Plain text on
      // the job's stdout, so the result comes from the text.
      id: "canary_runs",
      labels: ["result"],
      extractors: { result: "REGEXP_EXTRACT(textPayload, \"^canary (passed|FAILED) \")" },
      expected: true,
      description: "The scheduled canary's runs, by result (passed or FAILED).",
      base: CANARY_JOB(project),
      match: "textPayload=~\"^canary (passed|FAILED) \"",
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
  labelExtractors: Object.fromEntries(spec.labels.map(label => [label, spec.extractors?.[label] ?? `EXTRACT(jsonPayload.${label})`])),
  metricDescriptor: {
    metricKind: "DELTA",
    valueType: "INT64",
    labels: spec.labels.map(key => ({ key, valueType: "STRING" })),
  },
});

// Test records, written by --verify-alert: the alert conditions match them,
// the metrics never do.
const testRecords = project => `logName="projects/${project}/logs/${TEST_LOG}" AND jsonPayload.logName="security_audit" AND jsonPayload.event="monitoring-test"`;

export const metricType = name => `logging.googleapis.com/user/${name}`;

// A metric-threshold condition: the metric's points summed across every
// series (instances, revisions, label values) over a window, compared with a
// value. Log-match conditions match one record each and can't count.
//
// `type` names a built-in metric instead of a log-based one, and `where`
// narrows the series. `duration` and `evaluationMissingData` are for a
// missing-run (heartbeat) alert: Monitoring applies evaluationMissingData only
// when the retest window (`duration`) is at least 60 s, so a heartbeat sets
// both.
export const thresholdCondition = ({ metric, type, where, resourceType = "cloud_run_revision", value, period = "3600s", comparison = "COMPARISON_GT", duration = "0s", evaluationMissingData, displayName }) => ({
  displayName,
  conditionThreshold: {
    filter: `metric.type="${type ?? metricType(metric)}" AND resource.type="${resourceType}"${where ? ` AND ${where}` : ""}`,
    // ALIGN_SUM, not ALIGN_DELTA: log-based counters are DELTA metrics, and
    // ALIGN_DELTA interpolates across alignment boundaries, so a window could
    // read 6 for 5 records and open early. ALIGN_SUM counts exactly.
    aggregations: [{ alignmentPeriod: period, perSeriesAligner: "ALIGN_SUM", crossSeriesReducer: "REDUCE_SUM" }],
    comparison,
    thresholdValue: value,
    duration,
    trigger: { count: 1 },
    ...(evaluationMissingData ? { evaluationMissingData } : {}),
  },
});

const hours = period => {
  const s = Number(String(period).replace(/s$/, ""));
  return s % 3600 === 0 ? `${s / 3600} h` : `${s} s`;
};
const COMPARISONS = { COMPARISON_GT: "above", COMPARISON_GE: "at or above", COMPARISON_LT: "below", COMPARISON_LE: "at or below" };

// Notification text for a threshold policy. A metric incident has no log
// entry, so no ${log.extracted_label.*}: only variables Monitoring fills for
// metric conditions (${metric.*}, ${condition.*}, ${policy.*}), and the
// window and threshold written out. The observed value is in the incident
// summary Monitoring puts at the top of every notification; no documentation
// variable carries it. `nonce` (verifyThreshold's scratch policy only) goes
// in literally, so the email proves this policy, as applied, sent it.
export const thresholdDocumentation = (spec, { nonce } = {}) => {
  const { value, period = "3600s", comparison = "COMPARISON_GT" } = spec.threshold;
  return [
    spec.content,
    `Metric: \${metric.display_name} (\${metric.type}), summed across instances and revisions over ${hours(period)}. Condition: \${condition.display_name}, open while the sum is ${COMPARISONS[comparison] ?? comparison} ${value}. The observed value is in the incident summary above. Policy: \${policy.display_name}.`,
    ...(nonce ? [`Nonce: ${nonce}`] : []),
  ].join("\n\n");
};

// `canaryConnections`: the canary's connection ids. Its runs deny on purpose
// (denied final stage, revocation probe, author removed), so the denial alert
// leaves them out.
export const alertSpecs = (project, { canaryConnections = [] } = {}) => {
  const specs = Object.fromEntries(metricSpecs(project).map(s => [s.id, s]));
  const notCanary = canaryConnections.map(c => ` AND NOT jsonPayload.connectionId="${c}"`).join("");
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
    {
      id: "partial",
      displayName: "Security audit: partial write",
      filter: `(${specs.partial_writes.filter}) OR (${testRecords(project)} AND jsonPayload.outcome="partial")`,
      test: { outcome: "partial" },
      content: "A protected write stopped after some of its steps (Broker's outcome partial): part of it landed. Check the reason and category, and the item bank, before anyone saves again; see docs/protected-execution.md, Monitoring.",
    },
    {
      // `unavailable` only: a `conflict` is a same-key retry whose output
      // differs from the stored artifact, which is kept, not an outage.
      id: "artifact",
      displayName: "Security audit: artifact storage outage",
      filter: `(${specs.artifact_failures.filter} AND jsonPayload.category="unavailable") OR (${testRecords(project)} AND jsonPayload.reason="artifact-storage-unavailable")`,
      test: { outcome: "failed", reason: "artifact-storage-unavailable", category: "unavailable" },
      content: "A compile result through a connection could not be stored (artifact storage unavailable): views of it will fail until it is recompiled. Check api's Firestore access; see docs/protected-execution.md, Monitoring.",
    },
    {
      id: "denial",
      displayName: "Security audit: permission denial",
      filter: `(((${specs.policy_denials.filter}) OR (${specs.broker_local_refusals.filter}) OR (${specs.api_denials.filter})) AND jsonPayload.category="permission"${notCanary}) OR (${testRecords(project)} AND jsonPayload.outcome="denied" AND jsonPayload.category="permission")`,
      test: { outcome: "denied", reason: "not-granted", category: "permission" },
      content: "A protected request was refused for permission, outside the canary: someone without the access tried it, or access changed under a running item. Check the event and reason; see docs/protected-execution.md, Monitoring.",
    },
    {
      // The global safeguard: Policy's mint bucket for system-session
      // execution tokens. Every viewer's preview shows the busy message
      // while it holds.
      id: "rate-limited",
      displayName: "Security audit: system preview signing rate-limited",
      filter: `(${selector(project)} AND resource.type="cloud_run_revision" AND ${limitSource(SYSTEM_PREVIEW_LIMIT_SOURCES[0])} AND jsonPayload.outcome="denied" AND jsonPayload.reason="${SYSTEM_PREVIEW_LIMIT_SOURCES[0].reason}") OR (${testRecords(project)} AND jsonPayload.reason="rate-limited")`,
      test: { outcome: "denied", reason: "rate-limited", category: "unavailable" },
      content: "Policy refused a system preview mint as `rate-limited`: the global signing safeguard is engaged, so previews without a connection show the busy message. Check `security_audit/system_signings`, and `system_preview_limited` by source, for a burst or abuse; see docs/protected-execution.md, Monitoring.",
    },
    {
      // A plan or contract refusal is `conflict`, not `permission`, so the
      // denial alert never sees it: every connection read of a saved L0176
      // item failed `plan-required` for days after the contract-v2 cutover
      // without one. In a supported workflow these reasons mean the gateway
      // and Policy disagree on the contract; nothing produces them on purpose
      // except the canary.
      id: "contract",
      sms: true,
      displayName: "Security audit: unexpected plan/contract refusal",
      filter: `(((${specs.policy_denials.filter}) OR (${specs.broker_local_refusals.filter}) OR (${specs.api_denials.filter})) AND jsonPayload.category="conflict" AND jsonPayload.reason=(${CONTRACT_REFUSALS.map(r => `"${r}"`).join(" OR ")})${notCanary}) OR (${testRecords(project)} AND jsonPayload.outcome="denied" AND jsonPayload.reason="plan-required")`,
      test: { outcome: "denied", reason: "plan-required", category: "conflict" },
      content: "A request was refused for its plan or contract version (plan-required, plan-mismatch, plan-binding-mismatch, invocation-incompatible or contract-version-unsupported), outside the canary. The gateway and Policy disagree on the contract, so this workflow fails for everyone: check the stage, the service's contract minimum and recent releases of api, Policy and Broker; see docs/protected-execution.md, Monitoring.",
    },
    {
      // The scheduled canary (P1 #2, B), every 6 h. Three ways a run can go
      // wrong, each its own alert: a check failed (its FAILED line); the
      // execution failed without one (a crash, the 15-minute timeout, an
      // image that wouldn't start); or no run passed at all for 13 h, two
      // missed runs, whatever the reason (the scheduler stopped, every run
      // failed, the job was deleted).
      id: "canary-failed",
      sms: true,
      displayName: "Canary: run FAILED",
      filter: `(${CANARY_JOB(project)} AND textPayload=~"^canary FAILED") OR (${testRecords(project)} AND jsonPayload.reason="canary-failed")`,
      test: { outcome: "failed", reason: "canary-failed" },
      content: "The scheduled canary failed one or more checks. Its output names them: `gcloud logging read 'resource.type=\"cloud_run_job\" resource.labels.job_name=\"canary\"' --project=graffiticode --freshness=1h`. See docs/protected-execution.md, Scheduled canary.",
    },
    {
      id: "canary-execution-failed",
      sms: true,
      displayName: "Canary: job execution failed",
      threshold: { type: "run.googleapis.com/job/completed_execution_count", resourceType: "cloud_run_job", where: "resource.labels.job_name=\"canary\" AND metric.labels.result=\"failed\"", value: 0, period: "3600s", comparison: "COMPARISON_GT" },
      content: "A scheduled canary execution failed (exit not 0, the 15-minute timeout, or a container that wouldn't start), possibly before it could print a verdict. `gcloud run jobs executions list --job=canary --region=us-central1 --project=graffiticode`. See docs/protected-execution.md, Scheduled canary.",
    },
    {
      id: "canary-missing",
      sms: true,
      displayName: "Canary: no passing run in 13 h",
      threshold: { metric: specs.canary_runs.name, resourceType: "cloud_run_job", where: "metric.labels.result=\"passed\"", value: 1, period: "46800s", comparison: "COMPARISON_LT", duration: "300s", evaluationMissingData: "EVALUATION_MISSING_DATA_ACTIVE" },
      content: "No scheduled canary run has passed for 13 hours (two missed runs): the scheduler stopped, the job is broken, or every run failed. `gcloud scheduler jobs describe canary --location=us-central1 --project=graffiticode`. See docs/protected-execution.md, Scheduled canary.",
    },
    {
      id: "system-signings",
      displayName: "Security audit: system signings over 600 in an hour",
      threshold: { metric: specs.system_signings.name, value: 600, period: "3600s", comparison: "COMPARISON_GT" },
      content: "More than 600 executions under the system preview session in an hour (baseline: a few a day, about one per L0176 or L0158 item view's signing compile). Find the clients in api's `system-signing-limit` records and the refusals in `system_preview_limited` by source; see docs/protected-execution.md, Monitoring.",
    },
  ];
};

// `sms`: the operator's SMS channel, added beside email on the alerts that
// must reach a person at once (spec.sms: the plan/contract refusal and the
// scheduled canary, P1 #2 D). The email channel stays on every alert.
export const desiredPolicy = (spec, channel, { sms = null } = {}) => {
  const policy = spec.threshold ? desiredThresholdPolicy(spec, channel) : desiredLogPolicy(spec, channel);
  return spec.sms && sms ? { ...policy, notificationChannels: [channel, sms] } : policy;
};

// A metric-threshold policy. No notificationRateLimit: Monitoring accepts it
// only on log-match policies.
export const desiredThresholdPolicy = (spec, channel, { nonce } = {}) => ({
  displayName: spec.displayName,
  combiner: "OR",
  enabled: true,
  notificationChannels: [channel],
  documentation: { mimeType: "text/markdown", content: thresholdDocumentation(spec, { nonce }) },
  conditions: [thresholdCondition({ ...spec.threshold, displayName: spec.conditionName ?? spec.displayName })],
  alertStrategy: { autoClose: "1800s" },
});

const desiredLogPolicy = (spec, channel) => ({
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
  notificationChannels: [...(p.notificationChannels ?? [])].sort(),
  documentation: p.documentation?.content,
  conditions: (p.conditions ?? []).map(conditionView),
  rateLimit: p.alertStrategy?.notificationRateLimit?.period,
  autoClose: p.alertStrategy?.autoClose,
};
// Every field the script sets on a condition, of either kind: a changed
// threshold, comparison, window, aligner, reducer, duration or filter is an
// update, never "unchanged".
const conditionView = c => {
  if (c.conditionThreshold) {
    const t = c.conditionThreshold;
    return {
      displayName: c.displayName,
      kind: "threshold",
      filter: t.filter,
      aggregations: (t.aggregations ?? []).map(a => ({ alignmentPeriod: a.alignmentPeriod, perSeriesAligner: a.perSeriesAligner, crossSeriesReducer: a.crossSeriesReducer, groupByFields: a.groupByFields ?? [] })),
      comparison: t.comparison,
      // Monitoring returns the value as a double.
      thresholdValue: Number(t.thresholdValue ?? 0),
      duration: t.duration ?? "0s",
      trigger: t.trigger?.count ?? 1,
      evaluationMissingData: t.evaluationMissingData ?? null,
    };
  }
  return { displayName: c.displayName, kind: "log", filter: c.conditionMatchedLog?.filter, labelExtractors: c.conditionMatchedLog?.labelExtractors ?? {} };
};
export const policyChanged = (existing, desired) => !same(policyView(existing), policyView(desired));
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

// The operator's SMS channel for `number` (E.164). It must already exist and be
// verified: Monitoring texts a code before a channel can send, which the
// operator enters in the Cloud Console, so this script never creates one.
const findSmsChannel = async (api, project, number) => {
  const res = ok(await api("GET", `${MONITORING}/projects/${project}/notificationChannels?filter=${encodeURIComponent("type=\"sms\"")}`), "notificationChannels.list");
  const channel = (res.notificationChannels ?? []).find(c => c.labels?.number === number);
  if (!channel) throw new Error(`no SMS channel for ${number}: create it in the Cloud Console (Monitoring, Alerting, Edit notification channels) and verify it`);
  if (channel.verificationStatus !== "VERIFIED") throw new Error(`the SMS channel for ${number} is not verified; verify it in the Cloud Console first`);
  return channel;
};

const findPolicy = async (api, project, displayName) => {
  const res = ok(await api("GET", `${MONITORING}/projects/${project}/alertPolicies?filter=${encodeURIComponent(`display_name="${displayName}"`)}`), "alertPolicies.list");
  const found = res.alertPolicies ?? [];
  if (found.length > 1) throw new Error(`${found.length} alert policies are named "${displayName}"; remove the extras`);
  return found[0] ?? null;
};

const metricUrl = (project, name) => `${LOGGING}/projects/${project}/metrics/${encodeURIComponent(name)}`;

// The changes --apply would make: create, update or unchanged, per resource.
export const plan = async ({ api, project, email, sms = null, canaryConnections = [] }) => {
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
  const smsChannel = sms ? await findSmsChannel(api, project, sms) : null;
  for (const spec of alertSpecs(project, { canaryConnections })) {
    const existing = await findPolicy(api, project, spec.displayName);
    const desired = desiredPolicy(spec, channel?.name ?? "(new channel)", { sms: smsChannel?.name });
    const action = !existing ? "create" : channel && same(policyView(existing), policyView(desired)) ? "unchanged" : "update";
    steps.push({ kind: "policy", name: spec.displayName, action, existing, spec });
  }
  return { steps, channel, smsChannel };
};

export const apply = async ({ api, project, email, sms = null, canaryConnections = [], log = () => {} }) => {
  const { steps, smsChannel } = await plan({ api, project, email, sms, canaryConnections });
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
      const desired = desiredPolicy(step.spec, channelName, { sms: smsChannel?.name });
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
export const writeTestRecords = async ({ api, project, email, sms = null, canaryConnections = [], now = () => new Date(), nonce = () => randomBytes(4).toString("hex"), log = () => {} }) => {
  const { steps } = await plan({ api, project, email, sms, canaryConnections });
  const pending = steps.filter(s => s.action !== "unchanged").map(s => `${s.kind} ${s.name}`);
  if (pending.length) throw new Error(`monitoring is not applied (${pending.join(", ")}); run --apply first`);
  const written = [];
  // Log-match alerts only: a threshold alert has no record to match (see
  // verifyThreshold).
  for (const spec of alertSpecs(project, { canaryConnections }).filter(s => s.test)) {
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

// Settles only the alerts whose nonce is typed (in any order): each is
// recorded delivered, and the rest stay pending for a later --confirm. With
// `settle`, the rest are recorded not confirmed instead (their emails never
// came). A nonce that matches no alert is reported, not ignored.
export const confirmDelivery = (written, typed, { now = () => new Date(), settle = false } = {}) => {
  const given = typed.map(t => String(t).trim().toLowerCase()).filter(Boolean);
  const at = now().toISOString();
  const result = w => ({ alert: w.alert, writtenAt: w.writtenAt, confirmedAt: at, delivered: given.includes(w.nonce) });
  const results = written.filter(w => settle || given.includes(w.nonce)).map(result);
  const remaining = settle ? [] : written.filter(w => !given.includes(w.nonce));
  const unknown = given.filter(g => !written.some(w => w.nonce === g));
  return { results, remaining, unknown };
};

// Threshold verification (plan system-preview-rate-limit, step 5). The
// log-match test above never exercises a metric: a threshold incident has no
// log entry, so its email can't carry a nonce from one. So, against a
// scratch metric and policy shaped like the real ones (same window, aligner,
// reducer and comparison, a low threshold):
//   1. the scratch metric is created first (a log-based metric counts only
//      entries written after it exists), and the scratch policy with a fresh
//      nonce written literally in its documentation;
//   2. a few test records, two under the threshold; the run waits until the
//      metric shows them, then holds, and the reading must stay at or below
//      the threshold, where a COMPARISON_GT condition must not open;
//   3. more records take it well past; the run waits until the metric does.
// The email that crossing causes carries the nonce: the metric was ingested,
// the condition evaluated and the notification delivered, in one test. An
// email with the nonce dated before the crossing means the condition opened
// at the threshold, not past it.
//
// The scratch records go to the test log (event monitoring-test, check
// threshold): no real metric counts them, and no log-match alert's test
// clause matches them (they carry no outcome, reason or category). Each run
// has its own metric, named by a run id that is not the nonce (the email
// shows the metric type, which must not give the nonce away); --cleanup
// removes every scratch metric and the scratch policy.
export const SCRATCH_METRIC_PREFIX = "security_audit/monitoring_test_threshold_";
export const SCRATCH_POLICY = "Security audit: monitoring test (threshold)";
export const SCRATCH_THRESHOLD = 5;
// The scratch condition's name, as the email's "Condition" line shows it.
export const scratchConditionName = nonce => `${SCRATCH_POLICY}, nonce ${nonce}`;

export const thresholdScratch = ({ project, channel, nonce, runId, threshold = SCRATCH_THRESHOLD }) => {
  const name = `${SCRATCH_METRIC_PREFIX}${runId}`;
  const metric = {
    name,
    description: "Scratch metric for scripts/monitoring.js --verify-threshold; remove with --cleanup.",
    filter: `${testRecords(project)} AND jsonPayload.check="threshold" AND jsonPayload.run="${runId}"`,
    labelExtractors: {},
    metricDescriptor: { metricKind: "DELTA", valueType: "INT64", labels: [] },
  };
  const spec = {
    displayName: SCRATCH_POLICY,
    // The notification email shows the condition's name, not the policy's
    // documentation, so the nonce goes there too (scratchConditionName).
    conditionName: scratchConditionName(nonce),
    threshold: { metric: name, resourceType: "global", value: threshold, period: "3600s", comparison: "COMPARISON_GT" },
    content: `Scratch policy for scripts/monitoring.js --verify-threshold (test records only, not an incident). It opens past ${threshold} test records in an hour, as the system-signings alert opens past 600. Remove it with --verify-threshold --cleanup --apply.`,
  };
  const policy = desiredThresholdPolicy(spec, channel, { nonce });
  const record = at => ({ jsonPayload: { logName: "security_audit", event: "monitoring-test", check: "threshold", run: runId, at } });
  // Margins, not exact counts: Monitoring regrids a delta point into the
  // query's windows, so a point split by a window edge can be counted in two,
  // and a reading may run one or two above the records written. So the check
  // writes well under the threshold, holds while the reading stays at or below
  // it, then writes well past it.
  return { metric, spec, policy, record, under: Math.max(1, threshold - 2), over: threshold + 3 };
};

// The metric's sum over the last window, aggregated as the condition does.
export const windowSum = async ({ api, project, metric, resourceType, period = "3600s", now = () => new Date() }) => {
  const end = now();
  const start = new Date(end.getTime() - Number(period.replace(/s$/, "")) * 1000);
  const q = new URLSearchParams({
    filter: `metric.type="${metricType(metric)}" AND resource.type="${resourceType}"`,
    "interval.startTime": start.toISOString(),
    "interval.endTime": end.toISOString(),
    "aggregation.alignmentPeriod": period,
    "aggregation.perSeriesAligner": "ALIGN_SUM",
    "aggregation.crossSeriesReducer": "REDUCE_SUM",
  });
  const res = ok(await api("GET", `${MONITORING}/projects/${project}/timeSeries?${q}`), "timeSeries.list");
  const point = res.timeSeries?.[0]?.points?.[0];
  // A count: round any double the API returns.
  return point ? Math.round(Number(point.value?.int64Value ?? point.value?.doubleValue ?? 0)) : 0;
};

const MINUTE = 60 * 1000;

// Dry run unless `apply`: returns what it would create and write, and the
// nonce, with no write. `wait` and the timings are injected for tests.
export const verifyThreshold = async ({
  api, project, email, apply: doApply = false, threshold = SCRATCH_THRESHOLD,
  nonce = randomBytes(4).toString("hex"), runId = randomBytes(4).toString("hex"),
  now = () => new Date(), wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  settleMs = 2 * MINUTE, holdMs = 5 * MINUTE, pollMs = 30 * 1000, ingestMs = 15 * MINUTE, metricReadyMs = 12 * MINUTE, log = () => {},
}) => {
  if (nonce === runId) throw new Error("the run id must not be the nonce");
  const channel = await findChannel(api, project, email);
  if (!channel && doApply) throw new Error(`no email channel for ${email}; run --apply first`);
  const scratch = thresholdScratch({ project, channel: channel?.name ?? "(the operator's channel)", nonce, runId, threshold });
  const existing = await findPolicy(api, project, SCRATCH_POLICY);
  const steps = [
    `create metric ${scratch.metric.name}`,
    `${existing ? "update" : "create"} policy ${SCRATCH_POLICY} (threshold ${threshold}; condition "${scratchConditionName(nonce)}", the name the email shows)`,
    `write ${scratch.under} test records (under the threshold ${threshold}; must not open), wait until the metric shows them, hold ${Math.round(holdMs / 1000)} s with it at or below ${threshold}`,
    `write ${scratch.over - scratch.under} more (${scratch.over} in all, past it), wait until the metric shows more than ${threshold}`,
  ];
  if (!doApply) return { applied: false, nonce, runId, scratch, steps };

  ok(await api("POST", `${LOGGING}/projects/${project}/metrics`, scratch.metric), `metrics.create ${scratch.metric.name}`);
  log(`  created metric ${scratch.metric.name}`);
  // A new log-based metric takes a moment to exist for Monitoring (a policy
  // on it can be refused until then) and to start counting.
  await wait(settleMs);
  // Monitoring can take up to 10 minutes to know a new log-based metric, and
  // refuses a policy on it until then (404 "Cannot find metric(s)"), so retry
  // that refusal until `metricReadyMs`.
  const putPolicy = () => (existing
    ? api("PATCH", `${MONITORING}/${existing.name}?updateMask=displayName,combiner,enabled,notificationChannels,documentation,conditions,alertStrategy`, scratch.policy)
    : api("POST", `${MONITORING}/projects/${project}/alertPolicies`, scratch.policy));
  const policyDeadline = now().getTime() + metricReadyMs;
  for (;;) {
    const res = await putPolicy();
    const unknownMetric = res.status === 404 && /Cannot find metric/.test(JSON.stringify(res.json ?? ""));
    if (!unknownMetric || now().getTime() >= policyDeadline) {
      ok(res, `alertPolicies.${existing ? "patch" : "create"} ${SCRATCH_POLICY}`);
      break;
    }
    log("  Monitoring doesn't know the new metric yet; retrying the policy");
    await wait(pollMs);
  }
  log(`  ${existing ? "updated" : "created"} policy ${SCRATCH_POLICY}`);

  const write = async n => {
    const at = now().toISOString();
    ok(await api("POST", `${LOGGING}/entries:write`, {
      logName: `projects/${project}/logs/${TEST_LOG}`,
      resource: { type: "global", labels: { project_id: project } },
      entries: Array.from({ length: n }, () => scratch.record(at)),
    }), "entries:write");
    return at;
  };
  const sum = () => windowSum({ api, project, metric: scratch.metric.name, resourceType: "global", now });
  const limit = scratch.spec.threshold.value;
  // Wait until the reading reaches `atLeast`; while waiting, a reading past
  // `atMost` fails (the condition could already open).
  const until = async (atLeast, atMost = Infinity) => {
    const deadline = now().getTime() + ingestMs;
    for (;;) {
      const seen = await sum();
      if (seen > atMost) throw new Error(`the scratch metric shows ${seen}, past the threshold ${atMost} with only ${atLeast} written: the condition could open early; run --cleanup and start again`);
      if (seen >= atLeast) return seen;
      if (now().getTime() >= deadline) throw new Error(`the scratch metric shows ${seen}, not ${atLeast}, after ${Math.round(ingestMs / 1000)} s: not ingested`);
      await wait(pollMs);
    }
  };

  const underAt = await write(scratch.under);
  const seenUnder = await until(scratch.under, limit);
  log(`  the metric shows ${seenUnder} for ${scratch.under} written (${underAt}); holding ${Math.round(holdMs / 1000)} s under the threshold ${limit}`);
  await wait(holdMs);
  const held = await sum();
  if (held > limit) throw new Error(`the scratch metric rose to ${held} during the hold, past the threshold ${limit}: run --cleanup and start again`);
  const crossedAt = await write(scratch.over - scratch.under);
  const seenOver = await until(limit + 1);
  log(`  the metric shows ${seenOver} for ${scratch.over} written (crossed ${crossedAt})`);
  return { applied: true, nonce, runId, scratch, steps, underAt, crossedAt };
};

// The scratch metrics and policy, removed only with `apply`.
export const cleanupThreshold = async ({ api, project, apply: doApply = false, log = () => {} }) => {
  const metrics = [];
  let pageToken;
  do {
    const res = ok(await api("GET", `${LOGGING}/projects/${project}/metrics?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`), "metrics.list");
    metrics.push(...(res.metrics ?? []).filter(m => m.name.startsWith(SCRATCH_METRIC_PREFIX)));
    pageToken = res.nextPageToken;
  } while (pageToken);
  const res = ok(await api("GET", `${MONITORING}/projects/${project}/alertPolicies?filter=${encodeURIComponent(`display_name="${SCRATCH_POLICY}"`)}`), "alertPolicies.list");
  const policies = res.alertPolicies ?? [];
  const steps = [...policies.map(p => `delete policy ${p.displayName} (${p.name})`), ...metrics.map(m => `delete metric ${m.name}`)];
  if (!doApply) return { applied: false, steps };
  // The policy first: it refers to the metric.
  for (const p of policies) ok(await api("DELETE", `${MONITORING}/${p.name}`), `alertPolicies.delete ${p.name}`);
  for (const m of metrics) ok(await api("DELETE", metricUrl(project, m.name)), `metrics.delete ${m.name}`);
  for (const s of steps) log(`  ${s}`);
  return { applied: true, steps };
};
