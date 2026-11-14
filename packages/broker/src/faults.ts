// The C6 activation drive's fault (docs/c6-l0176-commands-plan.md §6), read
// from the environment of a service other than production's broker.
//
//   BROKER_FAULTS            drop-outcome, fail-write (B6's drive), or unset
//     drop-outcome           a write that succeeded records no outcome and
//                            fails as a lost response (C6)
//     fail-write             a claimed write fails before any provider
//                            request, recorded `failed` (provider-rejected):
//                            nothing is written (B6, docs/b6-command-repair-plan.md slice 5)
//   BROKER_FAULT_PRINCIPALS  comma-separated uids the fault applies to (the canary's)
//
// The production service (K_SERVICE=broker) refuses to start with any fault
// set: the drive's broker is its own service, `broker-faults`, reached only by
// the staged compiler that names it.

export const PRODUCTION_SERVICE = "broker";

export const parseFaults = (env: Record<string, string | undefined>) => {
  const kind = (env.BROKER_FAULTS ?? "").trim();
  if (!kind) return null;
  if (kind !== "drop-outcome" && kind !== "fail-write") throw new Error(`BROKER_FAULTS must be drop-outcome or fail-write, not ${kind}`);
  if (env.K_SERVICE === PRODUCTION_SERVICE) throw new Error("BROKER_FAULTS is refused on the production broker service");
  const principals = new Set((env.BROKER_FAULT_PRINCIPALS ?? "").split(",").map(s => s.trim()).filter(Boolean));
  if (!principals.size) throw new Error("BROKER_FAULTS needs BROKER_FAULT_PRINCIPALS");
  return { dropOutcome: kind === "drop-outcome", failWrite: kind === "fail-write", principals };
};
