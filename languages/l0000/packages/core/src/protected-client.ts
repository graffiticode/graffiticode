// SPDX-License-Identifier: MIT
//
// The compiler's client for the policy authority and the credential broker.
// One snapshot per compile (admission), then for each protected call: mint an
// execution token for exactly that request, and spend it at the broker. The
// compiler never sees a connection's credential.
//
// Every request carries the calling service's identity twice, as Cloud Run
// requires: an invoker ID token for Cloud Run IAM (X-Serverless-Authorization,
// audience = the service URL) and a caller ID token policy/broker verify
// themselves (X-Caller-Identity, audience = the service URN). In production
// both come from the metadata server for this compiler's service account.

import type { ExecContext, ProtectedCall } from "./exec-context.js";
import type { PolicyClient, PolicySnapshot } from "./protected-functions.js";
import { argsDigest } from "./canonical.js";

export interface ProtectionClientOptions {
  policyUrl: string;
  brokerUrl: string;
  // (audience) -> Google ID token for this service account.
  idToken: (audience: string) => Promise<string>;
  fetch?: typeof fetch;
}

export const POLICY_AUDIENCE = "urn:graffiticode:policy";
export const BROKER_AUDIENCE = "urn:graffiticode:broker";

// A protected call that did not return an outcome. `reason` and `category`
// are policy's or the broker's (spec FAIL-01; an older service sends no
// category). `effectUnknown`: the broker was asked to act and its answer was
// lost, so the provider may have changed (an uncertain write, not a refusal).
export class ProtectedCallError extends Error {
  status: number;
  reason?: string;
  category?: string;
  effectUnknown: boolean;
  constructor(message: string, status: number, reason?: string, { category, effectUnknown = false }: { category?: string; effectUnknown?: boolean } = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.category = category;
    this.effectUnknown = effectUnknown;
  }
}

const EXECUTE = "/v1/execute";

export function createProtectionClient({ policyUrl, brokerUrl, idToken, fetch: doFetch = fetch }: ProtectionClientOptions): PolicyClient {
  const post = async (baseUrl: string, urn: string, path: string, body: unknown, bearer?: string | null) => {
    const [invoker, caller] = await Promise.all([idToken(baseUrl), idToken(urn)]);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Serverless-Authorization": `Bearer ${invoker}`,
      "X-Caller-Identity": caller,
    };
    if (bearer) {
      headers.Authorization = `Bearer ${bearer}`;
    }
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    } catch {
      // No answer at all. Asking the broker to act may have acted.
      throw new ProtectedCallError(`${path} unreachable`, 0, undefined, { effectUnknown: path === EXECUTE });
    }
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      // fall through with a null body
    }
    if (!res.ok || json?.status !== "success") {
      const reason = typeof json?.error?.reason === "string" ? json.error.reason : undefined;
      const category = typeof json?.error?.category === "string" ? json.error.category : undefined;
      // The broker refuses with a reason, before acting; an execute that
      // failed without one (a crash, a proxy error) may have acted.
      throw new ProtectedCallError(`${path} failed (${res.status})`, res.status, reason, { category, effectUnknown: path === EXECUTE && !reason });
    }
    return json.data;
  };

  return {
    async getSnapshot({ exec, langID, fns }): Promise<PolicySnapshot> {
      const { userToken, invocationToken } = exec.policyCredentials();
      const data = await post(policyUrl, POLICY_AUDIENCE, "/v1/snapshot", {
        lang: langID,
        connectionId: exec.connectionId,
        fns,
        invocationToken: invocationToken ?? undefined,
        stage: exec.stage ?? undefined,
      }, userToken);
      if (typeof data?.sessionToken === "string") {
        exec.setSessionToken(data.sessionToken);
      }
      return { allowed: data?.allowed };
    },

    async invoke(exec: ExecContext, { fn, op, payload, occurrenceId }: ProtectedCall) {
      if (!exec.sessionToken) {
        throw new ProtectedCallError("no policy session for this invocation", 403, "no-session");
      }
      const { executionToken } = await post(policyUrl, POLICY_AUDIENCE, "/v1/mint", {
        sessionToken: exec.sessionToken,
        fn,
        op,
        occurrenceId,
        argsDigest: argsDigest(payload),
      });
      return post(brokerUrl, BROKER_AUDIENCE, EXECUTE, { op, payload }, executionToken);
    },
  };
}
