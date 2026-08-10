import { Router } from "express";
import { InvalidArgumentError } from "../errors/http.js";
import {
  buildHttpHandler,
  createSuccessResponse,
  parseIdsFromRequest,
  parseAuthTokenFromRequest,
  setImmutableCacheHeaders,
  setNoStoreCacheHeaders,
  optionsHandler
} from "./utils.js";

export const buildGetData = ({ taskStorer, compileStorer, dataApi }) => {
  // `action` is an out-param the caller can supply to learn about the compile
  // (see data.js): `compiled` for logging, `noStore` when the result expires.
  // Callers that don't care (routes/compile.js) can omit it.
  return async ({ auth, authToken, ids, action = {} }) => {
    if (ids.length < 1) {
      throw new InvalidArgumentError("must provide at least one id");
    }
    const objs = await Promise.all(ids.map(id => dataApi.get({
      taskStorer, compileStorer, id, auth, authToken, action
    })));
    let data;
    if (objs.length > 1) {
      data = objs;
    } else {
      data = objs[0];
    }
    return data;
  };
};

const buildGetDataHandler = ({ taskStorer, compileStorer, dataApi }) => {
  const getData = buildGetData({ taskStorer, compileStorer, dataApi });
  return buildHttpHandler(async (req, res) => {
    const auth = req.auth.context;
    const authToken = parseAuthTokenFromRequest(req);
    const ids = parseIdsFromRequest(req);
    const action = {};
    const data = await getData({ auth, authToken, ids, action });
    if (action.noStore) {
      // At least one of these ids compiles to output that expires.
      setNoStoreCacheHeaders(res);
    } else {
      // No auth context means the request was anonymous; a 200 can only have
      // returned public tasks (private ones throw NotFound), so it's shareable.
      setImmutableCacheHeaders(res, { isPublic: auth === null });
    }
    res.status(200).json(createSuccessResponse({ data }));
  });
};

export default ({ taskStorer, compileStorer, dataApi }) => {
  const router = new Router();
  router.get("/", buildGetDataHandler({ taskStorer, compileStorer, dataApi }));
  router.options("/", optionsHandler);
  return router;
};
