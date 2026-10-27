import { createClient } from "@graffiticode/auth/client";
import { UnauthenticatedError, UnavailableError } from "./errors/http.js";

// The auth service couldn't be asked about a token: a network error, or an
// answer that isn't auth's (the client accepts only 200, 400 and 401, so a 5xx
// or an edge error page arrives as a status error). Auth's own refusal is a
// 400 or 401 it answered, never this. The same rule as Policy's
// (packages/policy/src/app.ts, authUnreachable): on 2026-10-27 a verify call
// that never reached auth was answered as an invalid token.
const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
export const authUnreachable = err => {
  const status = err?.statusCode;
  return NETWORK_CODES.has(String(err?.code)) || NETWORK_CODES.has(String(err?.cause?.code)) ||
    (typeof status === "number" && (status >= 500 || status === 429)) ||
    /socket hang up|fetch failed/i.test(String(err?.message));
};

// `client` is for tests; production builds one for authUrl.
/** @param {{ authUrl?: string, client?: { verifyToken: (token: string) => Promise<{ uid: string }> } }} options */
export const buildValidateToken = ({ authUrl = "https://auth.graffiticode.com", client = createClient(authUrl) }) => {
  const verify = async token => {
    const { uid } = await client.verifyToken(token);
    return { uid };
  };
  return async token => {
    try {
      // Verifying only reads, so auth that couldn't be reached is asked once more.
      try {
        return await verify(token);
      } catch (err) {
        if (!authUnreachable(err)) throw err;
        return await verify(token);
      }
    } catch (err) {
      if (authUnreachable(err)) {
        console.warn(JSON.stringify({ event: "user-token", outcome: "refused", reason: "auth-unreachable", detail: String(err?.code ?? err?.statusCode ?? "").slice(0, 40) }));
        throw new UnavailableError("the user token could not be verified; retry");
      }
      throw new UnauthenticatedError(`${err.code} - ${err.message}`);
    }
  };
};
