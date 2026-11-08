// Recovery of abandoned commands (B5, docs/b5-commands-plan.md §7): Cloud
// Scheduler calls POST /internal/commands/sweep every minute. Each command
// whose owner stopped (pending, or with its publication due, with an expired
// lease) is taken over at the next generation and continued by the worker.
// Policy decides ownership: a takeover another sweeper won is just skipped.
// No user token is involved anywhere: the worker runs under the command's
// stored principal.

import { PolicyRefused } from "./policy-commands.js";

export const SWEEP_LIMIT = 20;

export const buildSweep = ({ policy, run, worker, limit = SWEEP_LIMIT, log = line => console.log(line) }) => async () => {
  const { commands } = await policy.due({ limit });
  const outcomes = { taken: 0, skipped: 0, failed: 0 };
  for (const { commandId, generation } of commands) {
    let taken;
    try {
      taken = await policy.lease({ commandId, worker, generation, takeOver: true });
    } catch (e) {
      if (!(e instanceof PolicyRefused)) throw e;
      // Another sweeper or a retrying caller took it first.
      outcomes.skipped++;
      continue;
    }
    outcomes.taken++;
    try {
      const state = await run({ commandId, generation: taken.generation });
      log(`command ${commandId}: recovered at generation ${taken.generation}, ${state.status}`);
    } catch (e) {
      // It stays pending; its lease expires and a later sweep continues it.
      outcomes.failed++;
      log(`WARN command ${commandId}: recovery stopped: ${e?.message}`);
    }
  }
  return { due: commands.length, ...outcomes };
};

// The sweep route's caller check: a Google ID token in Authorization, for
// `audience`, from one of `callers` (the scheduler's service account), with a
// verified email. `verifyIdToken(token, audience)` is common/caller's.
export const buildSweepAuthorizer = ({ verifyIdToken, audience, callers }) => async req => {
  const header = req.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) return false;
  try {
    const payload = await verifyIdToken(token, audience);
    return payload?.email_verified === true && callers.includes(payload.email);
  } catch {
    return false;
  }
};

// SWEEP_AUDIENCE and SWEEP_CALLERS (comma-separated service account emails):
// without both, the route isn't mounted.
export const parseSweepConfig = (env = process.env) => {
  const audience = env.SWEEP_AUDIENCE || null;
  const callers = (env.SWEEP_CALLERS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  return audience && callers.length ? { audience, callers } : null;
};
