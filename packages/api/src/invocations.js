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

export const buildAllocateInvocation = ({ policyUrl, idToken, fetch: doFetch = fetch }) =>
  async ({ authToken, connectionId, taskId, options, idempotencyKey = null }) => {
    const [invoker, caller] = await Promise.all([idToken(policyUrl), idToken("urn:graffiticode:policy")]);
    const res = await doFetch(`${policyUrl}/v1/invocations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
        "X-Serverless-Authorization": `Bearer ${invoker}`,
        "X-Caller-Identity": caller
      },
      body: JSON.stringify({
        connectionId,
        taskId,
        inputDigest: inputDigest(options),
        ...(idempotencyKey ? { idempotencyKey } : {})
      })
    });
    const body = await res.json().catch(() => null);
    if (res.status === 403) throw new InvocationRefused(body?.error?.reason ?? "denied");
    if (!res.ok || typeof body?.data?.invocationToken !== "string") {
      throw new Error(`policy invocation failed (${res.status})`);
    }
    return { invocationToken: body.data.invocationToken };
  };
