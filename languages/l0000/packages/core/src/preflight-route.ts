// SPDX-License-Identifier: MIT
//
// The compiler's `POST /preflight` (capability plan W4 decision 1; spec
// API-01), for the authenticated gateway only. Cloud Run IAM is unchanged
// (a language server stays public for anonymous compiles and /form), so the
// route authenticates the caller itself: `X-Caller-Identity` must be a Google
// ID token for one of the configured gateway service accounts, with exactly
// this language's audience (`urn:graffiticode:<lang>`), issued by Google,
// unexpired, for a verified email. The route is side-effect free: it runs the
// compiler's preflight (preflight.ts) and nothing else.
//
// Framework-free: a language server mounts it as
//   app.post("/preflight", async (req, res) => {
//     const out = await preflight({ headers: req.headers, body: req.body });
//     res.status(out.status).json(out.body);
//   });

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";

export class CallerRefused extends Error {
  status: number;
  reason: string;
  constructor(reason: string, status = 401) {
    super(`caller refused: ${reason}`);
    this.reason = reason;
    this.status = status;
  }
}

export const languageAudience = (lang: string) => `urn:graffiticode:${String(lang).replace(/^L/i, "").padStart(4, "0")}`;

// `gateways`: the service-account emails allowed to preflight. `getKey`
// defaults to Google's published keys (injectable for tests).
export function createGatewayVerifier({
  lang,
  gateways,
  getKey = createRemoteJWKSet(new URL(GOOGLE_CERTS)),
}: {
  lang: string;
  gateways: string[];
  getKey?: JWTVerifyGetKey;
}) {
  const audience = languageAudience(lang);
  const allowed = new Set(gateways.map(g => g.trim().toLowerCase()).filter(Boolean));
  return async (headers: Record<string, unknown>) => {
    const raw = headers["x-caller-identity"];
    const token = typeof raw === "string" ? raw.replace(/^Bearer\s+/i, "").trim() : "";
    if (!token) throw new CallerRefused("caller-rejected");
    let payload;
    try {
      ({ payload } = await jwtVerify(token, getKey, { issuer: GOOGLE_ISSUERS, audience, algorithms: ["RS256"] }));
    } catch {
      throw new CallerRefused("caller-rejected");
    }
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (payload.email_verified !== true || !allowed.has(email)) throw new CallerRefused("route-not-allowed-for-caller", 403);
    return { email };
  };
}

const STAGE = /^s\d{1,3}$/;

// `compiler` is the language's Compiler (its `preflight`); `verifyCaller` a
// createGatewayVerifier. Returns { status, body } in the platform's envelope.
export function createPreflightHandler({
  compiler,
  verifyCaller,
}: {
  // A Compiler: its `langID` and `preflight` (typed loosely, as the class is).
  compiler: any;
  verifyCaller: (headers: Record<string, unknown>) => Promise<unknown>;
}) {
  const refused = (status: number, reason: string, message: string) =>
    ({ status, body: { status: "error", error: { code: status, message, reason }, data: null } });
  return async ({ headers, body }: { headers: Record<string, unknown>; body: any }) => {
    try {
      await verifyCaller(headers ?? {});
    } catch (e: any) {
      if (e instanceof CallerRefused) return refused(e.status, e.reason, "preflight is for the gateway only");
      throw e;
    }
    const { stage, lang, code, options } = body ?? {};
    if (typeof stage !== "string" || !STAGE.test(stage) || !code || typeof code !== "object") {
      return refused(400, "bad-request", "preflight needs { stage, lang, code, options? }");
    }
    if (lang !== undefined && String(lang).replace(/^L/i, "").padStart(4, "0") !== compiler.langID) {
      return refused(400, "bad-request", `this compiler is ${compiler.langID}, not ${lang}`);
    }
    const result = await compiler.preflight(code, { stage, options: options ?? {} });
    return { status: 200, body: { status: "success", data: result.errors ? { errors: result.errors } : { manifest: result.manifest } } };
  };
}

// Google ID tokens for this service's own account, from the Cloud Run
// metadata server, cached until shortly before they expire.
const METADATA_IDENTITY = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";
const cache = new Map<string, { token: string; exp: number }>();
export async function metadataIdToken(audience: string): Promise<string> {
  const hit = cache.get(audience);
  if (hit && hit.exp - 60 > Date.now() / 1000) return hit.token;
  const res = await fetch(`${METADATA_IDENTITY}?audience=${encodeURIComponent(audience)}&format=full`, {
    headers: { "Metadata-Flavor": "Google" },
  });
  if (!res.ok) throw new Error(`metadata identity token failed (${res.status})`);
  const token = await res.text();
  const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  cache.set(audience, { token, exp: Number(payload.exp) || 0 });
  return token;
}
