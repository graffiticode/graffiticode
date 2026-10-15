// RETAIN-01 checks (W5 stage 2): protected records never expire, backups and
// point-in-time recovery are configured, and a restored backup holds what
// production held. Cloud access is injected (scripts/test/retention.test.js);
// scripts/retention-check.js wires gcloud and Firestore.
//
// Protected records (spec RETAIN-01): invocation records, idempotency
// bindings, admission plans, receipt claims and outcomes. Only token-replay
// records, in-flight markers, system preview sessions' signature slots and
// leases may expire.

export const DATABASES = Object.freeze(["policy", "broker", "(default)", "revisions"]);

// Collections whose documents may expire (spec RETAIN-01): token replay ids,
// in-flight execution markers, system preview sessions' signature slots
// (`system-session-slots`, cleanup-only: each slot's expiresAt is past the
// last moment any token of its session can execute, so its count holds until
// then; Broker session-slots.js), and admission leases.
export const MAY_EXPIRE = Object.freeze({
  policy: ["admission-leases"],
  broker: ["jtis", "active-executions", "system-session-slots"],
  "(default)": [],
  revisions: [],
});

// The protected collections a restore must reproduce, per database.
export const PROTECTED = Object.freeze({
  policy: ["invocations", "idempotency-keys", "invocation-sequences", "plans"],
  broker: ["receipts", "receipts/*/steps", "receipts/*/outcome"],
});

const collectionGroupOf = fieldName => /\/collectionGroups\/([^/]+)\/fields\//.exec(fieldName)?.[1] ?? null;

// One database's configuration, from `run(args)` (gcloud, JSON out). Each part
// is "pass", "fail" or "incomplete" with a detail; a gcloud failure is never a pass.
export const checkDatabase = async ({ run, project, database }) => {
  const attempt = async args => {
    try {
      return { ok: true, value: await run([...args, `--project=${project}`, `--database=${database}`, "--format=json"]) };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
    }
  };
  const out = { database };

  const ttls = await attempt(["firestore", "fields", "ttls", "list"]);
  if (!ttls.ok) out.ttl = { result: "incomplete", detail: ttls.error };
  else {
    // Any TTL configuration counts, whatever its state (creating, active, needs repair).
    const fields = (ttls.value ?? []).filter(f => Boolean(f?.ttlConfig));
    const groups = fields.map(f => collectionGroupOf(f.name)).filter(Boolean);
    const allowed = MAY_EXPIRE[database] ?? [];
    const offending = groups.filter(g => !allowed.includes(g));
    out.ttl = offending.length
      ? { result: "fail", detail: `TTL policies on protected collections: ${offending.join(", ")}` }
      : { result: "pass", detail: groups.length ? `TTL only on ${groups.join(", ")}` : "no TTL policies" };
  }

  const describe = await attempt(["firestore", "databases", "describe"]);
  if (!describe.ok) out.pitr = { result: "incomplete", detail: describe.error };
  else {
    const enabled = describe.value?.pointInTimeRecoveryEnablement === "POINT_IN_TIME_RECOVERY_ENABLED";
    out.pitr = enabled
      ? { result: "pass", detail: `enabled, versions kept ${describe.value.versionRetentionPeriod ?? "unknown"}` }
      : { result: "fail", detail: "point-in-time recovery is off" };
  }

  const schedules = await attempt(["firestore", "backups", "schedules", "list"]);
  if (!schedules.ok) out.backups = { result: "incomplete", detail: schedules.error };
  else {
    const list = schedules.value ?? [];
    out.backups = list.length
      ? { result: "pass", detail: list.map(s => `${s.dailyRecurrence ? "daily" : s.weeklyRecurrence ? `weekly (${s.weeklyRecurrence.day ?? "?"})` : "unknown"}, kept ${s.retention ?? "?"}`).join("; ") }
      : { result: "fail", detail: "no backup schedule" };
  }
  return out;
};

// The configuration verdict: "pass" only when every part of every database
// passes; any incomplete part makes the whole incomplete, never a pass.
export const configVerdict = results => {
  const parts = results.flatMap(r => [r.ttl, r.pitr, r.backups]);
  if (parts.some(p => p.result === "fail")) return "fail";
  if (parts.some(p => p.result === "incomplete")) return "incomplete";
  return "pass";
};

// --- Restore comparison ---------------------------------------------------
//
// The reference set is the documents last updated before a cutoff T: the
// earlier of the two restored backups' snapshot times, minus a margin. Such a
// document has the same contents in production now as in either backup, so it
// is compared field for field, with no point-in-time read. A document created
// before T but updated since (e.g. an invocation that later got its plan
// digest) is checked for existence only. Each relationship is checked only
// where both ends are in the reference set, or exist before T.

export const CUTOFF_MARGIN_MS = 60_000;

const canonical = value => JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]]))
  : v));

const matchesPattern = (path, pattern) => {
  const p = path.split("/");
  const q = pattern.split("/");
  // A document path has one more segment than its collection pattern.
  if (p.length !== q.length + 1) return false;
  return q.every((seg, i) => seg === "*" || seg === p[i]);
};

// `docs`: [{ path, data, createTime, updateTime }] (times in ms), for one
// database. Returns the documents under the protected patterns.
const protectedDocs = (docs, patterns) => docs.filter(d => patterns.some(p => matchesPattern(d.path, p)));

// Compare one database. `production` and `restored` are document lists;
// `cutoff` in ms. Returns counts and the first problems found.
export const compareDatabase = ({ database, production, restored, cutoff }) => {
  const patterns = PROTECTED[database] ?? [];
  const prod = protectedDocs(production, patterns);
  const byPath = new Map(protectedDocs(restored, patterns).map(d => [d.path, d]));
  const reference = prod.filter(d => d.updateTime < cutoff);
  const updatedSince = prod.filter(d => d.createTime < cutoff && d.updateTime >= cutoff);
  const problems = [];
  for (const d of reference) {
    const r = byPath.get(d.path);
    if (!r) problems.push(`missing ${d.path}`);
    else if (canonical(r.data) !== canonical(d.data)) problems.push(`differs ${d.path}`);
  }
  for (const d of updatedSince) if (!byPath.has(d.path)) problems.push(`missing (updated since) ${d.path}`);
  const counts = {};
  for (const p of patterns) {
    counts[p] = {
      reference: reference.filter(d => matchesPattern(d.path, p)).length,
      restoredOfReference: reference.filter(d => matchesPattern(d.path, p) && byPath.has(d.path)).length,
    };
  }
  return { database, reference: reference.length, updatedSince: updatedSince.length, counts, problems };
};

// Relationships across the two databases, among records that existed before
// the cutoff: idempotency key -> invocation, invocation -> plan, and plan ->
// receipts by `pld`. Checked in the restores.
export const compareRelationships = ({ policyRestored, brokerRestored, policyProduction, brokerProduction, cutoff }) => {
  const problems = [];
  const before = docs => docs.filter(d => d.createTime < cutoff);
  const restoredPaths = new Set([...policyRestored, ...brokerRestored].map(d => d.path));
  const inGroup = (docs, group) => docs.filter(d => matchesPattern(d.path, group));
  for (const key of inGroup(before(policyProduction), "idempotency-keys")) {
    const target = `invocations/${key.data.invocationId}`;
    if (key.data.invocationId && policyProduction.some(d => d.path === target && d.createTime < cutoff) && !restoredPaths.has(target)) {
      problems.push(`key ${key.path} -> ${target} missing in restore`);
    }
  }
  for (const inv of inGroup(before(policyProduction), "invocations")) {
    const digest = inv.data.planDigest;
    const target = digest ? `plans/${digest}` : null;
    if (target && inv.updateTime < cutoff && policyProduction.some(d => d.path === target && d.createTime < cutoff) && !restoredPaths.has(target)) {
      problems.push(`invocation ${inv.path} -> ${target} missing in restore`);
    }
  }
  const plans = new Set(inGroup(before(policyProduction), "plans").map(p => p.path.split("/")[1]));
  for (const receipt of inGroup(before(brokerProduction), "receipts")) {
    if (receipt.data.pld && plans.has(receipt.data.pld) && !restoredPaths.has(receipt.path)) {
      problems.push(`plan ${receipt.data.pld} -> ${receipt.path} missing in restore`);
    }
  }
  return problems;
};

// The cutoff for two restores, from their backups' exact snapshot times (ms).
// Never rounded; refused if either is missing or invalid.
export const cutoffFor = snapshotTimes => {
  if (!snapshotTimes.length || snapshotTimes.some(t => !Number.isFinite(t))) throw new Error("each restore needs its backup's snapshot time");
  return Math.min(...snapshotTimes) - CUTOFF_MARGIN_MS;
};

// Fixtures: the canary's receipts written before the cutoff must be among
// the reference documents, and present in the restore.
export const fixtureCheck = ({ brokerProduction, brokerRestored, cutoff, canaryConnections }) => {
  const fixtures = brokerProduction.filter(d => matchesPattern(d.path, "receipts") && d.updateTime < cutoff &&
    canaryConnections.includes(d.data?.binding?.connectionId));
  const restored = new Set(brokerRestored.map(d => d.path));
  const missing = fixtures.filter(d => !restored.has(d.path)).map(d => d.path);
  return { fixtures: fixtures.length, missing };
};
