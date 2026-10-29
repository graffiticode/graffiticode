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
  setNoStoreCacheHeaders
} from "./utils.js";
import { isNonNullObject } from "../util.js";
import { InvalidArgumentError } from "../errors/http.js";
import { countSigningStages, isSigningLang } from "../signing-limit.js";
import { checkGeneration, getActiveGeneration, parseGenerationParam } from "../generation.js";

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

// An item's signing stages (signing-limit.js): those of its stored chain, or
// its inline task. The data task an item's `data` becomes is L0000's.
const signingStagesOf = async ({ taskStorer, item, auth }) => (
  item.id
    ? countSigningStages(await taskStorer.get({ id: item.id, auth }))
    : (isSigningLang(item.lang) ? 1 : 0)
);

const buildPostCompileHandler = ({ taskStorer, compileStorer, dataApi, signingLimiter = null }) => {
  const getData = buildGetData({ taskStorer, compileStorer, dataApi });
  const postTasks = buildPostTasks({ taskStorer });
  return buildHttpHandler(async (req, res) => {
    const auth = req.auth.context;
    const authToken = parseAuthTokenFromRequest(req);
    const items = getItemsFromRequest(req);
    const connectionId = parseConnectionId(req.body?.connectionId, { auth });
    const idempotencyKey = parseIdempotencyKey(req.get("Idempotency-Key") ?? req.body?.idempotencyKey, { connectionId });
    // The per-client signing limit: with no connection, every L0176 stage of
    // every item signs under the system preview session. Charged for the
    // whole request before any task is written or any stage dispatched.
    if (signingLimiter && !connectionId) {
      const counts = await Promise.all(items.map(item => signingStagesOf({ taskStorer, item, auth })));
      await signingLimiter.charge(req, counts.reduce((a, b) => a + b, 0));
    }
    const ids = [];
    EMPTY_OBJECT_ID =
      EMPTY_OBJECT_ID ||
      await postTasks({ auth, tasks: getTaskFromData({}), req });
    let data = await Promise.all(items.map(async (item, i) => {
      let { id, lang, code, data } = item;
      // L0158's requested generation (B4): a recompile from a View that loaded
      // the item under it stays in that namespace. Checked here against the
      // item's own chain, before its data task is added; getData checks it
      // again with exactly that one task allowed.
      const generation = parseGenerationParam(item.generation);
      if (generation !== undefined) {
        if (connectionId) {
          throw new InvalidArgumentError("a compile under a generation can't run through a connection");
        }
        const own = id ? await taskStorer.get({ id, auth }) : [{ lang, code }];
        checkGeneration({ generation, active: getActiveGeneration(), tasks: own });
      }
      if (!id) {
        id = await postTasks({ auth, tasks: { lang, code }, req });
      }
      data = data || {};
      const tasks = getTaskFromData(data);
      const dataId = await postTasks({ auth, tasks, req });
      let generationDataTask = false;
      if (dataId !== EMPTY_OBJECT_ID && id.indexOf(dataId) < 0) {
        id = [id, dataId].join("+");
        generationDataTask = generation !== undefined;
      }
      ids.push(id);
      // One key per item, so a multi-item request's invocations stay distinct.
      const itemKey = idempotencyKey && items.length > 1 ? `${idempotencyKey}.${i}` : idempotencyKey;
      return await getData({ auth, authToken, ids: [id], connectionId, idempotencyKey: itemKey, generation, generationDataTask });
    }));
    if (data.length === 1) {
      data = data[0];
    }
    const [id] = ids;
    res.set("Access-Control-Allow-Origin", "*");
    // A compile's data can carry a signed provider request (an L0176
    // preview), which must never be stored by a browser or a CDN (PROVIDER-01,
    // AT-10 caches).
    setNoStoreCacheHeaders(res);

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

// `signingLimiter` (signing-limit.js), when given, charges each request's
// system signing stages; without one nothing is charged.
export default ({ taskStorer, compileStorer, dataApi, signingLimiter = null }) => {
  // @ts-expect-error TS-MIGRATE: express Router is callable; its types reject `new`
  const router = new Router();
  router.post("/", buildPostCompileHandler({ taskStorer, compileStorer, dataApi, signingLimiter }));
  return router;
};
