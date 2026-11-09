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
//   API_COMMAND_FAULT_PRINCIPALS  comma-separated uids the faults apply to (the canary's)
//
// The production service (K_SERVICE=api) refuses to start with any fault set:
// the drive's api is its own service, `api-drive`.

export const PRODUCTION_SERVICE = "api";
export const KINDS = Object.freeze(["exit-after-write", "lose-head-answer"]);

export const parseCommandFaults = (env = process.env, { exit = () => process.exit(1) } = {}) => {
  const kinds = (env.API_COMMAND_FAULTS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (!kinds.length) return null;
  const unknown = kinds.filter(k => !KINDS.includes(k));
  if (unknown.length) throw new Error(`API_COMMAND_FAULTS: unknown ${unknown.join(", ")}`);
  if (env.K_SERVICE === PRODUCTION_SERVICE) throw new Error("API_COMMAND_FAULTS is refused on the production api service");
  const principals = new Set((env.API_COMMAND_FAULT_PRINCIPALS ?? "").split(",").map(s => s.trim()).filter(Boolean));
  if (!principals.size) throw new Error("API_COMMAND_FAULTS needs API_COMMAND_FAULT_PRINCIPALS");
  return {
    exitAfterWrite: kinds.includes("exit-after-write"),
    loseHeadAnswer: kinds.includes("lose-head-answer"),
    appliesTo: uid => principals.has(uid),
    exit,
  };
};
