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

import { createLocalJWKSet, jwtVerify } from "jose";
import type { JSONWebKeySet } from "jose";
import type { ExecContext, ProtectedCall } from "./exec-context.js";
import type { PolicyClient, PolicySnapshot } from "./protected-functions.js";
import { argsDigest } from "./canonical.js";

export interface ProtectionClientOptions {
  policyUrl: string;
  // Optional: a language with no protected functions (L0000) asks policy for
  // its stage binding and never executes anything at the broker.
  brokerUrl?: string | null;
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

// Policy's session profile (packages/policy/src/tokens.ts): a session is
// accepted as policy's only if policy signed it, for policy, as a session.
const SESSION = { issuer: "urn:graffiticode:policy", audience: POLICY_AUDIENCE, typ: "gc-session+jwt", algorithms: ["ES256"] };

export function createProtectionClient({ policyUrl, brokerUrl = null, idToken, fetch: doFetch = fetch }: ProtectionClientOptions): PolicyClient {
  // Policy's public keys, fetched once and again when a session names a key
  // not seen yet (rotation).
  let keys: ReturnType<typeof createLocalJWKSet> | null = null;
  const loadKeys = async () => {
    const res = await doFetch(`${policyUrl}/v1/jwks`, { method: "GET", headers: { "X-Serverless-Authorization": `Bearer ${await idToken(policyUrl)}` } });
    const json: any = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(json?.keys)) throw new ProtectedCallError(`/v1/jwks failed (${res.status})`, res.status, "unavailable");
    keys = createLocalJWKSet(json as JSONWebKeySet);
  };
  // A session's claims, once its signature, issuer, audience, type and
  // lifetime check out. The stage binding it carries is trusted from here only.
  const verifySession = async (sessionToken: string) => {
    if (!keys) await loadKeys();
    try {
      return (await jwtVerify(sessionToken, keys!, SESSION)).payload as Record<string, any>;
    } catch (e: any) {
      if (e?.code !== "ERR_JWKS_NO_MATCHING_KEY") throw new ProtectedCallError("the session from policy did not verify", 0, "bad-session");
      await loadKeys();
      try {
        return (await jwtVerify(sessionToken, keys!, SESSION)).payload as Record<string, any>;
      } catch {
        throw new ProtectedCallError("the session from policy did not verify", 0, "bad-session");
      }
    }
  };
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
    async getSnapshot({ exec, langID, fns, manifest }): Promise<PolicySnapshot> {
      const { userToken, invocationToken, admissionToken } = exec.policyCredentials();
      const data = await post(policyUrl, POLICY_AUDIENCE, "/v1/snapshot", {
        lang: langID,
        connectionId: exec.connectionId,
        fns,
        invocationToken: invocationToken ?? undefined,
        stage: exec.stage ?? undefined,
        // Under a plan: the admission and this stage's own manifest, which
        // policy compares with what the plan pins.
        ...(admissionToken ? { admissionToken, manifest } : {}),
      }, userToken);
      if (typeof data?.sessionToken !== "string") {
        return { allowed: data?.allowed };
      }
      // A planned stage executes only on a binding policy signed.
      const bind = admissionToken ? (await verifySession(data.sessionToken)).bind : undefined;
      exec.setSessionToken(data.sessionToken);
      return { allowed: data?.allowed, ...(admissionToken ? { bind } : {}) };
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
      if (!brokerUrl) {
        throw new ProtectedCallError("no broker is configured for this compiler", 0, "unavailable");
      }
      return post(brokerUrl, BROKER_AUDIENCE, EXECUTE, { op, payload }, executionToken);
    },
  };
}
