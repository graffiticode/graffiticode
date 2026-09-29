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

export class ProtectedCallError extends Error {
  status: number;
  reason?: string;
  constructor(message: string, status: number, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

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
    const res = await doFetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      // fall through with a null body
    }
    if (!res.ok || json?.status !== "success") {
      throw new ProtectedCallError(`${path} failed (${res.status})`, res.status, json?.error?.reason);
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
      return post(brokerUrl, BROKER_AUDIENCE, "/v1/execute", { op, payload }, executionToken);
    },
  };
}
