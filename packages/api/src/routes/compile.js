import { Router } from "express";
import { buildPostTasks } from "./tasks.js";
import { buildGetData } from "./data.js";
import {
  buildHttpHandler,
  createCompileSuccessResponse,
  createErrorResponse,
  createError,
  parseAuthTokenFromRequest,
  parseConnectionId,
  parseIdempotencyKey,
  optionsHandler
} from "./utils.js";
import { isNonNullObject } from "../util.js";
import { InvalidArgumentError } from "../errors/http.js";

function getItemsFromRequest(req) {
  const { body } = req;
  let items;
  if (body.item) {
    items = [].concat(body.item);
  } else if (body.id) {
    items = [].concat(body);
  } else {
    items = body;
  }
  if (!(Array.isArray(items) && items.every(item => isNonNullObject(item)))) {
    throw new InvalidArgumentError("item must be a non-null object");
  }
  return items;
}

const getTaskFromData = data => ({
  lang: "0000",
  code: {
    1: {
      elts: [
        JSON.stringify(data)
      ],
      tag: "STR"
    },
    2: {
      elts: [
        1
      ],
      tag: "JSON"
    },
    root: 2
  }
});

let EMPTY_OBJECT_ID;

const buildPostCompileHandler = ({ taskStorer, compileStorer, dataApi }) => {
  const getData = buildGetData({ taskStorer, compileStorer, dataApi });
  const postTasks = buildPostTasks({ taskStorer });
  return buildHttpHandler(async (req, res) => {
    const auth = req.auth.context;
    const authToken = parseAuthTokenFromRequest(req);
    const items = getItemsFromRequest(req);
    const connectionId = parseConnectionId(req.body?.connectionId, { auth });
    const idempotencyKey = parseIdempotencyKey(req.get("Idempotency-Key") ?? req.body?.idempotencyKey, { connectionId });
    const ids = [];
    EMPTY_OBJECT_ID =
      EMPTY_OBJECT_ID ||
      await postTasks({ auth, tasks: getTaskFromData({}), req });
    let data = await Promise.all(items.map(async (item, i) => {
      let { id, lang, code, data } = item;
      if (!id) {
        id = await postTasks({ auth, tasks: { lang, code }, req });
      }
      data = data || {};
      const tasks = getTaskFromData(data);
      const dataId = await postTasks({ auth, tasks, req });
      if (dataId !== EMPTY_OBJECT_ID && id.indexOf(dataId) < 0) {
        id = [id, dataId].join("+");
      }
      ids.push(id);
      // One key per item, so a multi-item request's invocations stay distinct.
      const itemKey = idempotencyKey && items.length > 1 ? `${idempotencyKey}.${i}` : idempotencyKey;
      return await getData({ auth, authToken, ids: [id], connectionId, idempotencyKey: itemKey });
    }));
    if (data.length === 1) {
      data = data[0];
    }
    const [id] = ids;
    res.set("Access-Control-Allow-Origin", "*");

    // Check if getData returned an error (e.g., usage limit reached)
    // @ts-expect-error TS-MIGRATE: data is one item or an array; guarded by optional chaining
    if (data?.status === "error") {
      // @ts-expect-error TS-MIGRATE: data is one item or an array; guarded by optional chaining
      const errorMessage = data.errors?.[0]?.message || "Compilation failed";
      res.status(402).json(createErrorResponse(createError(402, errorMessage)));
      return;
    }

    res.status(200).json(createCompileSuccessResponse({ id, data }));
  });
};

export default ({ taskStorer, compileStorer, dataApi, compile }) => {
  // @ts-expect-error TS-MIGRATE: express Router is callable; its types reject `new`
  const router = new Router();
  // @ts-expect-error TS-MIGRATE: checkJs infers a destructured parameter's type from its default; optional fields read as missing
  router.post("/", buildPostCompileHandler({ taskStorer, compileStorer, dataApi, compile }));
  router.options("/", optionsHandler);
  return router;
};
