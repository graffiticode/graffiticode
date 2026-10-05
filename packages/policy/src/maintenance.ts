// The protected-execution switch (capability plan W0): a server-side control,
// read on each request, that Policy (snapshot, preview session, mint) and
// Broker (execute) consult before doing any protected work. Off, they refuse
// with the explicit reason `maintenance` (HTTP 503) and change nothing.
//
// Precedence:
//   1. PROTECTED_EXECUTION=disabled in the service environment is a hard
//      disable: it always wins and needs a deploy to undo.
//   2. Otherwise the dynamic flag decides: a Firestore document
//      `controls/protected-execution` in the service's own database, flipped
//      without a deploy (scripts/protected-execution.js). Protected execution
//      is on only when the document says `enabled: true`.
//   3. A missing or unreadable flag fails closed: off.
//
// Because a missing flag means off, the flag documents must exist (enabled)
// before the first release that carries this switch reaches traffic.
//
// A successful read is reused for `cacheMs` (default 2 s), so a flip takes
// effect within that bound; a failed read is never reused. `state({ fresh:
// true })` skips the cache: Broker uses it after registering a write as active,
// which is what lets `drain` trust an empty count (see broker.js).
//
// Canary (W0): while the flag is off, it may name one canary account and its
// dedicated connection, `canary: { uid, connectionId }`. Protected work for
// exactly that pair is still admitted (every normal check still applies), so a
// release can be verified end to end while ordinary traffic stays paused.
// Callers match it only against verified identity (a verified user or token
// claims), never request fields. A hard disable, a missing or unreadable flag,
// or a malformed canary admits no one.

export const PROTECTED_EXECUTION_DOC = "controls/protected-execution";
export const MAINTENANCE = "maintenance";

// PROTECTED_EXECUTION: unset or empty (the flag decides) or "disabled". Any
// other value stops the service rather than guessing.
export const parseHardDisable = value => {
  if (value === undefined || value === null || String(value).trim() === "") return false;
  if (String(value).trim() === "disabled") return true;
  throw new Error(`PROTECTED_EXECUTION must be unset or "disabled", not ${JSON.stringify(value)}`);
};

const ID_RE = /^[A-Za-z0-9_:.-]{1,200}$/;
const isId = v => typeof v === "string" && ID_RE.test(v);
const canaryOf = value => (value && typeof value === "object" && isId(value.uid) && isId(value.connectionId)
  ? Object.freeze({ uid: value.uid, connectionId: value.connectionId })
  : null);

// May this (verified) principal and connection do protected work in `state`?
// -> "enabled" | "canary" | null
// `principal` is verified identity; anything but strings never matches.
export const admission = (state, principal: { uid?: unknown, connectionId?: unknown } = {}) => {
  const { uid, connectionId } = principal;
  if (state.enabled) return "enabled";
  const { canary } = state;
  if (canary && typeof uid === "string" && uid === canary.uid && connectionId === canary.connectionId) return "canary";
  return null;
};

// `readFlag` resolves to the flag document's data, or null when it is absent.
export const createProtectedSwitch = ({ hardDisabled = false, readFlag, cacheMs = 2000, now = Date.now }) => {
  if (typeof readFlag !== "function") throw new Error("the protected-execution switch needs a flag reader");
  let cached = null;
  const read = async fresh => {
    if (!fresh && cached && now() - cached.at < cacheMs) return cached.state;
    let state;
    try {
      const flag = await readFlag();
      if (!flag) state = { enabled: false, source: "flag-missing" };
      else {
        const enabled = flag.enabled === true;
        state = { enabled, source: "flag", ...(enabled ? {} : { canary: canaryOf(flag.canary) }) };
      }
    } catch {
      return { enabled: false, source: "flag-unreadable" };
    }
    cached = { at: now(), state };
    return state;
  };
  return {
    // -> { enabled, source, canary? }   source: env-disabled | flag | flag-missing | flag-unreadable
    async state(options: { fresh?: boolean } = {}) {
      if (hardDisabled) return { enabled: false, source: "env-disabled" };
      return read(Boolean(options.fresh));
    },
  };
};

export const createFirestoreFlagReader = db => async () => {
  const snap = await db.doc(PROTECTED_EXECUTION_DOC).get();
  return snap.exists ? snap.data() : null;
};
