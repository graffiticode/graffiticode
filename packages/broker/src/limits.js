// Broker time limits (capability plan W0). They bound how long one execution
// can run, which is what a release waits out when draining:
//
//   providerCallMs  each provider request, response body included, is
//                   abandoned after this; the outcome is then uncertain
//   executionMs     the whole operation: no provider request starts after
//                   this much time, so the last one ends by
//                   executionMs + providerCallMs at the latest
//
// maxExecutionMs adds a margin for recording the outcome. Activity entries
// expire then, and an operator who cannot count active executions waits that
// long after switching protected execution off.
//
// BROKER_PROVIDER_CALL_TIMEOUT_MS and BROKER_EXECUTION_DEADLINE_MS override the
// defaults; anything that is not a positive integer, or a provider timeout
// longer than the deadline, or a deadline past the execution token's 60 s
// lifetime, stops the service.

export const DEFAULT_LIMITS = Object.freeze({ providerCallMs: 10_000, executionMs: 30_000 });
const RECORD_MARGIN_MS = 10_000;
const TOKEN_LIFETIME_MS = 60_000;

export const maxExecutionMs = ({ providerCallMs, executionMs }) => executionMs + providerCallMs + RECORD_MARGIN_MS;

const positiveInt = (name, value, fallback) => {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer of milliseconds, not ${JSON.stringify(value)}`);
  return n;
};

export const parseLimits = env => {
  const providerCallMs = positiveInt("BROKER_PROVIDER_CALL_TIMEOUT_MS", env.BROKER_PROVIDER_CALL_TIMEOUT_MS, DEFAULT_LIMITS.providerCallMs);
  const executionMs = positiveInt("BROKER_EXECUTION_DEADLINE_MS", env.BROKER_EXECUTION_DEADLINE_MS, DEFAULT_LIMITS.executionMs);
  if (providerCallMs > executionMs) throw new Error("BROKER_PROVIDER_CALL_TIMEOUT_MS cannot exceed BROKER_EXECUTION_DEADLINE_MS");
  if (executionMs > TOKEN_LIFETIME_MS) throw new Error("BROKER_EXECUTION_DEADLINE_MS cannot exceed the 60 s execution token lifetime");
  return Object.freeze({ providerCallMs, executionMs });
};
