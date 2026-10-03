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
// How long a service may keep acting on a cached "on" after the flag flips
// (packages/policy/src/maintenance.js cacheMs), plus time for a request
// admitted just before the flip to register as active. `drain` trusts an
// empty count only after this.
export const SETTLE_MS = 2_000 + 3_000;

const ID = /^[A-Za-z0-9_:.-]{1,200}$/;

export const parse = (argv, { verifyUid }) => {
  const [command, ...rest] = argv;
  const opts = { command, project: "graffiticode", databases: ["policy", "broker"], reason: null, maxMs: DEFAULT_MAX_MS, uid: null, connection: null, clear: false };
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (key === "--clear") {
      opts.clear = true;
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

export const setCanary = async (dbs, canary, { reason, by, now = () => new Date() }) => {
  for (const { db } of dbs) {
    await db.doc(DOC).set({ canary, canaryReason: reason, canaryUpdatedAt: now().toISOString(), canaryUpdatedBy: by }, { merge: true });
  }
};

// Active writes recorded by Broker: activity entries not yet expired.
export const activeWrites = (db, now = new Date()) =>
  db.collection(ACTIVE).where("expiresAt", ">", now).count().get().then(s => s.data().count);

// After disable: done when Broker reports no active writes once the switch has
// settled, or when the bound has passed since Broker went off. A request
// admitted on a cached "on" arrived at most cacheMs after the flip and starts
// no provider request later than its arrival plus the deadline, so the time
// bound is maxMs plus the cache window.
export const drain = async (broker, { maxMs = DEFAULT_MAX_MS, settleMs = SETTLE_MS, now = Date.now, sleep, log }) => {
  const snap = await broker.doc(DOC).get();
  const flag = snap.exists ? snap.data() : null;
  if (flag?.enabled === true) throw new Error("drain refuses while Broker is on: disable first");
  const offSince = flag?.updatedAt ? Date.parse(flag.updatedAt) : now();
  const bound = maxMs + 2_000;
  for (;;) {
    const waited = now() - offSince;
    const count = await activeWrites(broker, new Date(now()));
    if (count === 0 && waited >= settleMs) {
      log(`drained: no active writes (${Math.round(waited / 1000)} s since Broker was switched off)`);
      return { by: "count", waited };
    }
    if (waited >= bound) {
      log(`drained by time: ${bound} ms have passed since Broker was switched off (${count} entries not yet expired)`);
      return { by: "time", waited };
    }
    log(count === 0
      ? `settling: ${Math.round((settleMs - waited) / 1000)} s until an empty count can be trusted`
      : `waiting: ${count} active write(s), ${Math.round((bound - waited) / 1000)} s left of the bound`);
    await sleep(Math.min(2_000, Math.max(1, (count === 0 ? settleMs : bound) - waited)));
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
  }
};
