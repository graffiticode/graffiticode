import { Router } from "express";
import { InvalidArgumentError } from "../errors/http.js";
import {
  buildHttpHandler,
  createSuccessResponse,
  parseIdsFromRequest,
  parseAuthTokenFromRequest,
  parseConnectionId,
  setImmutableCacheHeaders,
  setNoStoreCacheHeaders,
  optionsHandler
} from "./utils.js";

export const buildGetData = ({ taskStorer, compileStorer, dataApi }) => {
  // `action` is an out-param the caller can supply to learn about the compile
  // (see data.js): `compiled` for logging, `noStore` when the result expires.
  // Callers that don't care (routes/compile.js) can omit it.
  return async ({ auth, authToken, ids, action = {}, refresh = false, connectionId = null }) => {
    if (ids.length < 1) {
      throw new InvalidArgumentError("must provide at least one id");
    }
    const objs = await Promise.all(ids.map(id => dataApi.get({
      taskStorer, compileStorer, id, auth, authToken, action, refresh, connectionId
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
    // ?refresh=1 recompiles instead of answering from the compile cache, and
    // writes the fresh result back. A taskId is content-addressed over
    // {lang, code} and carries no compiler version, so after a language ships a
    // breaking change its cached compiles keep reporting the old verdict —
    // clean 200s for programs the checker now rejects. Callers that ASSERT
    // "this compiles" (the corpus ping, the sweep, the corpus generator) need
    // the compiler, not the record.
    //
    // Authenticated callers only: a recompile costs real work, so an anonymous
    // request must not be able to force one. The flag is ignored rather than
    // rejected, which keeps a public read working instead of 401-ing on a
    // query param.
    const refresh = auth !== null && ["1", "true"].includes(String(req.query.refresh || ""));
    const connectionId = parseConnectionId(req.query.connection, { auth });
    const action = {};
    const data = await getData({ auth, authToken, ids, action, refresh, connectionId });
    // A refreshed response must not be held anywhere. The id is immutable but
    // we just proved its data is not, and the whole point of asking was to get
    // past a stale copy — an immutable header here would plant another one in
    // the CDN and in the caller's browser.
    if (refresh) {
      setNoStoreCacheHeaders(res);
      res.status(200).json(createSuccessResponse({ data }));
      return;
    }
    if (action.noStore || connectionId) {
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
