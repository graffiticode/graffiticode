// SPDX-License-Identifier: MIT
import { createClient } from "@graffiticode/auth/client";
import { UnauthenticatedError } from "./errors/http.js";

export const buildValidateToken = ({ authUrl = "https://auth.graffiticode.org" }: { authUrl?: string }) => {
  const client = createClient(authUrl);
  return async (token: string) => {
    try {
      return await client.verifyToken(token);
    } catch (err: any) {
      throw new UnauthenticatedError(`${err.code} - ${err.message}`);
    }
  };
};
