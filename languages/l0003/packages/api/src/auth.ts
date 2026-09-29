// SPDX-License-Identifier: MIT
import { UnauthenticatedError } from "./errors/http.js";

// Verifies a token against the Graffiticode auth service (POST /oauth/verify). Mirrors
// `createClient(url).verifyToken` from `@graffiticode/auth/client`, without pulling in
// that package's server-side dependency tree (firebase-admin, OpenTelemetry, ...).
const verifyToken = async (authUrl: string, idToken: string) => {
  const res = await fetch(`${authUrl}/oauth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (![200, 400, 401].includes(res.status)) {
    const err: any = new Error(`auth service responded with ${res.status}`);
    err.code = res.status;
    throw err;
  }
  const { status, error, data } = (await res.json()) as any;
  if (status !== "success") {
    const err: any = new Error(error?.message);
    err.code = error?.code;
    throw err;
  }
  return data;
};

export const buildValidateToken = ({ authUrl = "https://auth.graffiticode.org" }: { authUrl?: string }) => {
  return async (token: string) => {
    try {
      return await verifyToken(authUrl, token);
    } catch (err: any) {
      throw new UnauthenticatedError(`${err.code} - ${err.message}`);
    }
  };
};
