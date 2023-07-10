import { createClient } from "@graffiticode/auth/client";
import { UnauthenticatedError } from "./errors/http.js";

export const buildValidateToken = ({ authUrl = "https://auth.graffiticode.com" }) => {
  const client = createClient(authUrl);
  return async token => {
    try {
      const { uid } = await client.verifyToken(token);
      return { uid };
    } catch (err) {
      throw new UnauthenticatedError(`${err.code} - ${err.message}`);
    }
  };
};
