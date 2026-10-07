// Operations behind scripts/protected-execution.js, with the databases, clock
// and logger injected so the whole operator sequence can be tested
// (scripts/test/protected-execution.test.js). See the entry point for usage.
//
// The flag document holds two independent parts: the switch (`enabled`,
// `reason`, `updatedAt`, `updatedBy`) and the canary (`canary`, `canaryReason`,
// `canaryUpdatedAt`, `canaryUpdatedBy`). Every write merges, so flipping the
// switch never removes a configured canary, and setting the canary never moves
// the switch.

export const DOC = "controls/protected-execution";
export const ACTIVE = "active-executions";
export const DEFAULT_MAX_MS = 50_000;

const ID = /^[A-Za-z0-9_:.-]{1,200}$/;

export const parse = (argv, { verifyUid, productionProject }) => {
  const [command, ...rest] = argv;
  const opts = { command, project: "graffiticode", databases: ["policy", "broker"], reason: null, maxMs: DEFAULT_MAX_MS, uid: null, connection: null, clear: false, skipReleaseCheck: false };
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (key === "--clear") {
      opts.clear = true;
      continue;
    }
    if (key === "--skip-release-check") {
      opts.skipReleaseCheck = true;
      continue;
    }
    const value = rest[i + 1];
    if (!["--project", "--databases", "--reason", "--max-ms", "--uid", "--connection"].includes(key) || value === undefined) {
      throw new Error(`unknown or incomplete option ${key}`);
    }
    if (key === "--project") opts.project = value;
    if (key === "--databases") opts.databases = value.split(",").filter(Boolean);
    if (key === "--reason") opts.reason = value;
    if (key === "--uid") opts.uid = value;
    if (key === "--connection") opts.connection = value;
    if (key === "--max-ms") {
      opts.maxMs = Number(value);
      if (!Number.isInteger(opts.maxMs) || opts.maxMs <= 0) throw new Error("--max-ms must be a positive integer");
    }
    i++;
  }
  if (!["status", "enable", "disable", "drain", "canary"].includes(command)) throw new Error("command must be status, enable, disable, drain or canary");
  if (command === "canary") {
    if (opts.clear === Boolean(opts.uid || opts.connection)) throw new Error("canary needs --uid and --connection, or --clear");
    if (!opts.clear && !(ID.test(opts.uid ?? "") && ID.test(opts.connection ?? ""))) throw new Error("canary needs a valid --uid and --connection");
    if (opts.uid === verifyUid) throw new Error("the deploy-check account (VERIFY_UID) must never be the canary");
  }
  if (["enable", "disable", "canary"].includes(command) && !opts.reason?.trim()) throw new Error(`${command} needs --reason`);
  if (opts.skipReleaseCheck && command !== "enable") throw new Error("--skip-release-check applies only to enable");
  // The release check is what keeps production from re-enabling with stale
  // tags or below a milestone; it cannot be skipped there.
  if (opts.skipReleaseCheck && (!productionProject || opts.project === productionProject)) {
    throw new Error(`--skip-release-check is refused for the production project (${productionProject ?? "unknown"})`);
  }
  return opts;
};

// dbs: [{ name, db }] in policy, broker order. Disabling stops issuance
// (Policy) before execution (Broker); enabling reopens them in reverse.
export const setEnabled = async (dbs, enabled, { reason, by, now = () => new Date() }) => {
  const order = enabled ? [...dbs].reverse() : dbs;
  for (const { db } of order) {
    await db.doc(DOC).set({ enabled, reason, updatedAt: now().toISOString(), updatedBy: by }, { merge: true });
  }
};

// Switching protected execution back on requires every protected service to
// pass its release check (packages/deploy release-check): no stale tags, and
// nothing serving below its milestone baseline. `check` resolves to one result
// per service. Skipping is possible (a non-production project, the very first
// bootstrap) but is recorded in the flag document.
export const enableChecked = async (dbs, { reason, by, now, check, skip = false, log = () => {} }) => {
  if (!skip) {
    const results = await check();
    const failing = results.filter(r => !r.ok);
    for (const r of results) log(`release check ${r.service}: ${r.ok ? "ok" : "NOT READY"}`);
    if (failing.length) {
      const why = failing.map(r => [
        r.staleTags?.length ? `${r.service} has stale tags ${r.staleTags.join(", ")}` : null,
        r.belowBaseline?.length ? `${r.service} serves ${r.belowBaseline.join(", ")} below the ${r.baseline?.milestone} baseline` : null,
        r.contractMinimum?.length ? `${r.service} can reach ${r.contractMinimum.map(p => `${p.revision} (${p.problem})`).join(", ")} without the contract minimum` : null,
      ].filter(Boolean).join("; ") || `${r.service} is not ready`).join("; ");
      throw new Error(`refusing to enable protected execution: ${why}`);
    }
  }
  await setEnabled(dbs, true, { reason, by, now });
  for (const { db } of dbs) {
    await db.doc(DOC).set({ releaseCheckSkipped: skip }, { merge: true });
  }
};

export const setCanary = async (dbs, canary, { reason, by, now = () => new Date() }) => {
  for (const { db } of dbs) {
    await db.doc(DOC).set({ canary, canaryReason: reason, canaryUpdatedAt: now().toISOString(), canaryUpdatedBy: by }, { merge: true });
  }
};

// Active writes recorded by Broker: activity entries not yet expired.
export const activeWrites = (db, now = new Date()) =>
  db.collection(ACTIVE).where("expiresAt", ">", now).count().get().then(s => s.data().count);

// After disable: done when Broker reports no active writes, or when the bound
// has passed since Broker went off. An empty count is trusted at once, with no
// grace period, because of Broker's drain barrier (packages/broker/src/broker.js):
// every write registers as active and then re-reads the switch past its cache,
// so a write that registers after this count (which follows our read of the
// flag as off) is refused before any provider request. The canary is the one
// exception: it is still admitted, so do not run it while draining. The time
// bound (maxMs plus the switch's 2 s cache window) covers writes whose entries
// outlive their attempt (a crash), not registration timing.
export const drain = async (broker, { maxMs = DEFAULT_MAX_MS, now = Date.now, sleep, log }) => {
  const snap = await broker.doc(DOC).get();
  const flag = snap.exists ? snap.data() : null;
  if (flag?.enabled === true) throw new Error("drain refuses while Broker is on: disable first");
  if (flag?.canary) log(`note: the canary (${flag.canary.uid}) is still admitted; do not run it while draining`);
  const offSince = flag?.updatedAt ? Date.parse(flag.updatedAt) : now();
  const bound = maxMs + 2_000;
  for (;;) {
    const waited = now() - offSince;
    const count = await activeWrites(broker, new Date(now()));
    if (count === 0) {
      log(`drained: no active writes (${Math.round(waited / 1000)} s since Broker was switched off)`);
      return { by: "count", waited };
    }
    if (waited >= bound) {
      log(`drained by time: ${bound} ms have passed since Broker was switched off (${count} entries not yet expired)`);
      return { by: "time", waited };
    }
    log(`waiting: ${count} active write(s), ${Math.round((bound - waited) / 1000)} s left of the bound`);
    await sleep(Math.min(2_000, Math.max(1, bound - waited)));
  }
};

export const status = async (dbs, { project, log }) => {
  const broker = dbs.find(d => d.name === "broker")?.db;
  if (broker) log(`${project}/broker: ${await activeWrites(broker)} active write(s)`);
  for (const { name, db } of dbs) {
    const snap = await db.doc(DOC).get();
    const data = snap.exists ? snap.data() : null;
    const state = data?.enabled === true ? "ON" : "OFF";
    log(`${project}/${name}: ${state}${data?.updatedAt ? ` (by ${data.updatedBy} at ${data.updatedAt}: ${data.reason})` : data ? " (switch never set: fails closed)" : " (no flag document: fails closed)"}`);
    if (data?.canary) log(`  canary while off: ${data.canary.uid} on ${data.canary.connectionId}`);
    if (data?.enabled === true && data.releaseCheckSkipped) log("  enabled with the release check SKIPPED");
  }
};
