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
// W2 adds Policy authorization before each effect, which brings the token
// into the timing (decided 2026-10-05; the W2 plan, "Timing and token
// headroom"):
//
//   authorizeMs     the longest Broker waits for one authorization (ID token,
//                   request, response), and never past the deadline
//   headroomMs      H = executionMs + SKEW_MS: the lifetime a token must still
//                   have when an execution arrives. The token is presented only
//                   at authorizations, and no effect starts after the deadline,
//                   so it must outlast the deadline (plus SKEW_MS, an assumed
//                   bound on Policy's clock running ahead of Broker's; Policy
//                   checks expiry strictly). An in-flight provider request and
//                   recording the outcome never present it again: they bound
//                   drain (maxExecutionMs), not the token.
//
// A freshly minted token reaches Broker within MINT_TO_EXECUTE_MS of issue, so
// it arrives with at least TOKEN_LIFETIME_MS - MINT_TO_EXECUTE_MS left; every
// configuration must let such a token pass: H <= 50 s, so executionMs <= 40 s.
//
// BROKER_PROVIDER_CALL_TIMEOUT_MS, BROKER_EXECUTION_DEADLINE_MS and
// BROKER_AUTHORIZE_TIMEOUT_MS override the defaults; anything that is not a
// positive integer, or breaks one of the constraints above, stops the service.

export const DEFAULT_LIMITS = Object.freeze({ providerCallMs: 10_000, executionMs: 30_000, authorizeMs: 5_000 });
const RECORD_MARGIN_MS = 10_000;
const TOKEN_LIFETIME_MS = 60_000;
export const SKEW_MS = 10_000;
export const MINT_TO_EXECUTE_MS = 10_000;

export const maxExecutionMs = ({ providerCallMs, executionMs }) => executionMs + providerCallMs + RECORD_MARGIN_MS;
export const headroomMs = ({ executionMs }) => executionMs + SKEW_MS;

const positiveInt = (name, value, fallback) => {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer of milliseconds, not ${JSON.stringify(value)}`);
  return n;
};

export const parseLimits = env => {
  const providerCallMs = positiveInt("BROKER_PROVIDER_CALL_TIMEOUT_MS", env.BROKER_PROVIDER_CALL_TIMEOUT_MS, DEFAULT_LIMITS.providerCallMs);
  const executionMs = positiveInt("BROKER_EXECUTION_DEADLINE_MS", env.BROKER_EXECUTION_DEADLINE_MS, DEFAULT_LIMITS.executionMs);
  const authorizeMs = positiveInt("BROKER_AUTHORIZE_TIMEOUT_MS", env.BROKER_AUTHORIZE_TIMEOUT_MS, DEFAULT_LIMITS.authorizeMs);
  if (providerCallMs > executionMs) throw new Error("BROKER_PROVIDER_CALL_TIMEOUT_MS cannot exceed BROKER_EXECUTION_DEADLINE_MS");
  if (authorizeMs >= executionMs) throw new Error("BROKER_AUTHORIZE_TIMEOUT_MS must be less than BROKER_EXECUTION_DEADLINE_MS");
  const limits = Object.freeze({ providerCallMs, executionMs, authorizeMs });
  if (headroomMs(limits) > TOKEN_LIFETIME_MS - MINT_TO_EXECUTE_MS) {
    throw new Error(`BROKER_EXECUTION_DEADLINE_MS ${executionMs} needs ${headroomMs(limits)} ms of token lifetime (deadline + ${SKEW_MS} ms clock skew), more than a fresh token has (${TOKEN_LIFETIME_MS} ms lifetime - ${MINT_TO_EXECUTE_MS} ms from mint to execute): at most ${TOKEN_LIFETIME_MS - MINT_TO_EXECUTE_MS - SKEW_MS} ms`);
  }
  return limits;
};
