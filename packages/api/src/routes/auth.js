import { buildHttpHandler, parseAuthTokenFromRequest } from "./utils.js";

export default ({ validateToken }) => buildHttpHandler(async (req, res, next) => {
  req.auth = {};

  const token = parseAuthTokenFromRequest(req);
  req.auth.token = token;

  let authContext = null;
  if (token) {
    authContext = await validateToken(token);
    req.auth.uid = authContext.uid;
  }
  req.auth.context = authContext;

  next();
});
