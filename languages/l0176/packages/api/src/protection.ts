// SPDX-License-Identifier: MIT
// Connects the L0176 compiler to the policy authority and the credential
// broker when POLICY_URL and BROKER_URL are set. Without them, a compile that
// selects a connection is refused (the core compiler fails closed), and a
// compile without one returns its preview unsigned with a message.
//
// Previews for compiles without a connection are signed through a SYSTEM
// preview session (policy POST /v1/preview-session): a Graffiticode-owned
// connection whose credential only the broker holds, confined by policy to
// preview signing. This process holds no Learnosity secret.
import { createProtectionClient, ProtectedCallError, POLICY_AUDIENCE } from "@graffiticode/l0000";
import { compiler } from "@graffiticode/l0176";

// Google ID tokens for this service's own account, from the Cloud Run
// metadata server. Cached until shortly before they expire.
const METADATA_IDENTITY =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";
const cache = new Map<string, { token: string; exp: number }>();

export async function metadataIdToken(audience: string): Promise<string> {
  const hit = cache.get(audience);
  if (hit && hit.exp - 60 > Date.now() / 1000) {
    return hit.token;
  }
  const res = await fetch(`${METADATA_IDENTITY}?audience=${encodeURIComponent(audience)}&format=full`, {
    headers: { "Metadata-Flavor": "Google" },
  });
  if (!res.ok) {
    throw new Error(`metadata identity token failed (${res.status})`);
  }
  const token = await res.text();
  const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  cache.set(audience, { token, exp: Number(payload.exp) || 0 });
  return token;
}

// POST /v1/preview-session with this service's identity (the same two ID
// tokens as every policy call, see @graffiticode/l0000 protected-client) and
// no user token: the session is the system's, not a user's.
export function createPreviewSessionClient({
  policyUrl,
  idToken,
  fetch: doFetch = fetch,
}: {
  policyUrl: string;
  idToken: (audience: string) => Promise<string>;
  fetch?: typeof fetch;
}) {
  return async ({ langID }: { langID: string }) => {
    const [invoker, caller] = await Promise.all([idToken(policyUrl), idToken(POLICY_AUDIENCE)]);
    const res = await doFetch(`${policyUrl}/v1/preview-session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Serverless-Authorization": `Bearer ${invoker}`,
        "X-Caller-Identity": caller,
      },
      body: JSON.stringify({ lang: langID }),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      // fall through with a null body
    }
    if (!res.ok || json?.status !== "success") {
      throw new ProtectedCallError(`/v1/preview-session failed (${res.status})`, res.status, json?.error?.reason);
    }
    return json.data;
  };
}

export function configureProtection(
  env: NodeJS.ProcessEnv = process.env,
  { idToken = metadataIdToken, fetch: doFetch }: { idToken?: (audience: string) => Promise<string>; fetch?: typeof fetch } = {},
): boolean {
  const { POLICY_URL: policyUrl, BROKER_URL: brokerUrl } = env;
  if (!policyUrl || !brokerUrl) {
    return false;
  }
  const client = createProtectionClient({ policyUrl, brokerUrl, idToken, fetch: doFetch });
  (compiler as any).setPolicyClient({
    ...client,
    getPreviewSession: createPreviewSessionClient({ policyUrl, idToken, fetch: doFetch }),
  });
  return true;
}
