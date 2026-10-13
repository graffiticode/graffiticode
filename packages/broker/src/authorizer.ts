// Broker's side of authorize-execution (W2, spec EXEC-02 / API-02): before
// each effect Broker asks Policy whether that one step is still authorized.
// An authorizer resolves to { decisionId }, or throws:
//
//   AuthorizationDenied(reason)  Policy refused (403), or protected execution
//                                is paused: the effect must not happen
//   AuthorizationUnavailable     no decision: Policy unreachable, timed out,
//                                misconfigured or answering nonsense. Equally
//                                no effect, since without a decision nothing
//                                is authorized
//
// Broker bounds each call (broker.js) and never reuses a decision.

import { PolicyDenied } from "@graffiticode/policy";
import { buildPolicyRequest, PolicyRefused } from "@graffiticode/policy/client";

export class AuthorizationDenied extends Error {
  declare reason: string;
  constructor(reason: string) {
    super(`authorization denied: ${reason}`);
    this.reason = reason;
  }
}

export class AuthorizationUnavailable extends Error {}

const requestBody = ({ executionToken, op, argsDigest, step, purpose, after }) => ({ executionToken, op, argsDigest, step, purpose, after });

// Over HTTP, as Broker's own service account (the `broker` caller role).
export const buildPolicyAuthorizer = ({ policyUrl, idToken, fetch: doFetch = fetch }) => {
  const request = buildPolicyRequest({ policyUrl, idToken, fetch: doFetch });
  return async ({ signal, ...ask }: { signal?: AbortSignal, [field: string]: unknown }) => {
    let res;
    try {
      res = await request("POST", "/v1/authorize-execution", { body: requestBody(ask as any), signal });
    } catch (e) {
      if (e instanceof PolicyRefused) throw new AuthorizationDenied(e.reason);
      throw new AuthorizationUnavailable(`policy authorization unavailable: ${String(e?.name || e?.message || e)}`);
    }
    if (res.status === 503 && res.body?.error?.reason === "maintenance") throw new AuthorizationDenied("maintenance");
    const decisionId = res.body?.data?.decisionId;
    if (!res.ok || typeof decisionId !== "string") throw new AuthorizationUnavailable(`policy authorization failed (${res.status})`);
    return { decisionId };
  };
};

// In process, against a Policy object: for tests, which then exercise
// Policy's real decisions.
export const localAuthorizer = (policy, caller = { role: "broker" }) =>
  // `signal` is dropped: an in-process call can't be aborted.
  async ({ signal, ...ask }: { signal?: AbortSignal, [field: string]: unknown }) => {
    try {
      return await policy.authorizeExecution({ caller, ...requestBody(ask as any) });
    } catch (e) {
      if (e instanceof PolicyDenied) throw new AuthorizationDenied(e.reason);
      throw new AuthorizationUnavailable(String(e?.message || e));
    }
  };
