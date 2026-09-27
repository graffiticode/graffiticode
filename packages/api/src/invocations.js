// The gateway is the authenticated entry point for compiles, so it allocates
// the logical invocation (policy's POST /v1/invocations) before dispatching a
// compile through a selected connection. Every stage of the task chain runs
// under that one invocation; policy scopes each stage's operations by stage.
//
// Retries and redispatches send the same idempotency key and get the same
// invocation, so their writes return recorded outcomes instead of running
// again. Without a key, every request is a new invocation.

import { createHash } from "node:crypto";

export class InvocationRefused extends Error {
  constructor(reason) {
    super(`invocation refused: ${reason}`);
    this.reason = reason;
  }
}

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
};

export const inputDigest = options => createHash("sha256").update(canonical(options ?? {})).digest("hex");

// Google ID tokens for this service's own account, from the Cloud Run
// metadata server, cached until shortly before they expire.
const METADATA_IDENTITY =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

export const buildMetadataIdToken = ({ fetch: doFetch = fetch } = {}) => {
  const cache = new Map();
  return async audience => {
    const hit = cache.get(audience);
    if (hit && hit.exp - 60 > Date.now() / 1000) return hit.token;
    const res = await doFetch(`${METADATA_IDENTITY}?audience=${encodeURIComponent(audience)}&format=full`, {
      headers: { "Metadata-Flavor": "Google" }
    });
    if (!res.ok) throw new Error(`metadata identity token failed (${res.status})`);
    const token = await res.text();
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    cache.set(audience, { token, exp: Number(payload.exp) || 0 });
    return token;
  };
};

// One call to policy as the gateway: the invoker and caller identity tokens,
// and the end user's token when there is one. A 403 is policy's refusal, with
// its reason; anything else unexpected is an error.
export const buildPolicyRequest = ({ policyUrl, idToken, fetch: doFetch = fetch }) =>
  async (method, path, { body, authToken = null } = {}) => {
    const [invoker, caller] = await Promise.all([idToken(policyUrl), idToken("urn:graffiticode:policy")]);
    const res = await doFetch(`${policyUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        "X-Serverless-Authorization": `Bearer ${invoker}`,
        "X-Caller-Identity": caller
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const json = await res.json().catch(() => null);
    if (res.status === 403) throw new InvocationRefused(json?.error?.reason ?? "denied");
    return { status: res.status, ok: res.ok, body: json };
  };

export const buildAllocateInvocation = ({ policyUrl, idToken, fetch: doFetch = fetch }) => {
  const request = buildPolicyRequest({ policyUrl, idToken, fetch: doFetch });
  return async ({ authToken, connectionId, taskId, options, idempotencyKey = null }) => {
    const { ok, status, body } = await request("POST", "/v1/invocations", {
      authToken,
      body: {
        connectionId,
        taskId,
        inputDigest: inputDigest(options),
        ...(idempotencyKey ? { idempotencyKey } : {})
      }
    });
    const data = body?.data;
    if (!ok || typeof data?.invocationToken !== "string" || typeof data.invocationId !== "string" ||
        !Number.isInteger(data.seq) || typeof data.ownerUid !== "string") {
      throw new Error(`policy invocation failed (${status})`);
    }
    const { invocationToken, invocationId, seq, ownerUid } = data;
    return { invocationToken, invocationId, seq, ownerUid };
  };
};
