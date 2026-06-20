import { buildHttpHandler, parseAuthTokenFromRequest } from "./utils.js";

// GET reads of these resources are public when the underlying task is public,
// so a stale/invalid token must not turn a readable public resource into a 401.
// For these paths a failed token validation degrades to anonymous (which still
// serves only public content); every other route keeps the hard 401 contract.
const PUBLIC_READ_PATHS = ["/task", "/tasks", "/data", "/form"];

const isPublicRead = req =>
  req.method === "GET" &&
  PUBLIC_READ_PATHS.some(p => req.path === p || req.path.startsWith(`${p}/`));

export default ({ validateToken }) => buildHttpHandler(async (req, res, next) => {
  req.auth = {};

  const token = parseAuthTokenFromRequest(req);
  req.auth.token = token;

  let authContext = null;
  if (token) {
    try {
      authContext = await validateToken(token);
      req.auth.uid = authContext.uid;
    } catch (err) {
      // Falling back to anonymous can only reduce access (public-only), never
      // grant it — safe for reads. Writes/other routes still reject the token.
      if (!isPublicRead(req)) {
        throw err;
      }
      console.warn(
        `auth: ignoring invalid token on public read ${req.method} ${req.path}: ${err.message}`,
      );
      // Make the request byte-for-byte equivalent to an anonymous one: drop the
      // raw token too, so /form (the only route that reads req.auth.token) does
      // not forward an invalid access_token downstream.
      req.auth.token = null;
      authContext = null;
    }
  }
  req.auth.context = authContext;

  next();
});
