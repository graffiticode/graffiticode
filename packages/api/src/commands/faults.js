// The C6 activation drive's worker faults (docs/c6-l0176-commands-plan.md §6),
// read from the environment of a service other than production's api.
//
//   API_COMMAND_FAULTS            a comma-separated set, or unset:
//     exit-after-write            the process exits as soon as a stage's writes
//                                 have run, before the worker records anything
//                                 (a worker killed after a write; the
//                                 production sweeper takes the command over)
//     lose-head-answer            the head stage's answer is treated as lost
//                                 after its writes have run
//     exit-after-output           the process exits as soon as a stage below
//                                 the head has its output recorded, before the
//                                 next stage pins its input (B6, decision 5)
//   API_COMMAND_FAULT_PRINCIPALS  comma-separated uids the faults apply to (the canary's)
//   API_COMMAND_FAULT_TARGETS     C5d's drive (docs/c5d-snapshot-commands-plan.md, slice 1):
//                                 a JSON map from a target command id to a fault,
//                                 set once for a drive run:
//     stop-renewal                for that command at fencing generation 1 only,
//                                 the worker never renews its lease, and keeps its
//                                 compiler request open. The lease expires, the
//                                 sweeper takes the command over (generation 2),
//                                 and when the old request answers, the worker's
//                                 next Policy write is refused (stale or expired),
//                                 so it finishes nothing. A takeover is generation
//                                 2 or later, and is never affected.
//
// The production service (K_SERVICE=api) refuses to start with any fault set:
// the drive's api is its own service, `api-drive`.

export const PRODUCTION_SERVICE = "api";
export const KINDS = Object.freeze(["exit-after-write", "lose-head-answer", "exit-after-output"]);
export const TARGET_KINDS = Object.freeze(["stop-renewal"]);
const COMMAND_ID_RE = /^c:[0-9a-f]{64}$/;

// API_COMMAND_FAULT_TARGETS: null when unset; refused when malformed, or on
// the production service.
export const parseFaultTargets = (env = process.env) => {
  const raw = (env.API_COMMAND_FAULT_TARGETS ?? "").trim();
  if (!raw) return null;
  if (env.K_SERVICE === PRODUCTION_SERVICE) throw new Error("API_COMMAND_FAULT_TARGETS is refused on the production api service");
  let map;
  try {
    map = JSON.parse(raw);
  } catch {
    throw new Error("API_COMMAND_FAULT_TARGETS must be a JSON object");
  }
  if (!map || typeof map !== "object" || Array.isArray(map) || !Object.keys(map).length) throw new Error("API_COMMAND_FAULT_TARGETS must be a non-empty JSON object");
  for (const [id, kind] of Object.entries(map)) {
    if (!COMMAND_ID_RE.test(id)) throw new Error(`API_COMMAND_FAULT_TARGETS: ${id} isn't a command id`);
    if (!TARGET_KINDS.includes(kind)) throw new Error(`API_COMMAND_FAULT_TARGETS: unknown fault ${kind} for ${id}`);
  }
  const targets = new Map(Object.entries(map));
  // Only generation 1 of a named command: a takeover recovers unaffected.
  return { stopRenewal: (commandId, generation) => generation === 1 && targets.get(commandId) === "stop-renewal" };
};

export const parseCommandFaults = (env = process.env, { exit = () => process.exit(1) } = {}) => {
  const targets = parseFaultTargets(env);
  const kinds = (env.API_COMMAND_FAULTS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (!kinds.length) {
    return targets ? { exitAfterWrite: false, loseHeadAnswer: false, exitAfterOutput: false, appliesTo: () => false, exit, stopRenewal: targets.stopRenewal } : null;
  }
  const unknown = kinds.filter(k => !KINDS.includes(k));
  if (unknown.length) throw new Error(`API_COMMAND_FAULTS: unknown ${unknown.join(", ")}`);
  if (env.K_SERVICE === PRODUCTION_SERVICE) throw new Error("API_COMMAND_FAULTS is refused on the production api service");
  const principals = new Set((env.API_COMMAND_FAULT_PRINCIPALS ?? "").split(",").map(s => s.trim()).filter(Boolean));
  if (!principals.size) throw new Error("API_COMMAND_FAULTS needs API_COMMAND_FAULT_PRINCIPALS");
  return {
    exitAfterWrite: kinds.includes("exit-after-write"),
    loseHeadAnswer: kinds.includes("lose-head-answer"),
    exitAfterOutput: kinds.includes("exit-after-output"),
    appliesTo: uid => principals.has(uid),
    exit,
    stopRenewal: targets ? targets.stopRenewal : () => false,
  };
};
