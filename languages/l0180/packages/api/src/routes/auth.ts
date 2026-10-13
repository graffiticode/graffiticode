// SPDX-License-Identifier: MIT
import { buildHttpHandler, parseAuthTokenFromRequest } from "./utils.js";

// Attaches req.auth (token + validated context). Does NOT reject anonymous requests —
// authorization is enforced per-route where needed.
export default ({ validateToken }: { validateToken: (token: string) => Promise<any> }) =>
  buildHttpHandler(async (req, _res, next) => {
    const auth: any = {};
    const token = parseAuthTokenFromRequest(req);
    auth.token = token;
    let authContext = null;
    if (token) {
      authContext = await validateToken(token);
      auth.uid = authContext?.uid;
    }
    auth.context = authContext;
    (req as any).auth = auth;
    next();
  });
