// SPDX-License-Identifier: MIT
// Connects the L0176 compiler to the policy authority and the credential
// broker when POLICY_URL and BROKER_URL are set. Without them, a compile that
// selects a connection is refused (the core compiler fails closed).
import { createProtectionClient } from "@graffiticode/l0000";
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

export function configureProtection(env: NodeJS.ProcessEnv = process.env): boolean {
  const { POLICY_URL: policyUrl, BROKER_URL: brokerUrl } = env;
  if (!policyUrl || !brokerUrl) {
    return false;
  }
  (compiler as any).setPolicyClient(createProtectionClient({ policyUrl, brokerUrl, idToken: metadataIdToken }));
  return true;
}
