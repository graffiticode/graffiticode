import { Router } from "express";
import { buildPostTasks } from "./tasks.js";
import { buildGetData } from "./data.js";
import {
  buildHttpHandler,
  createCompileSuccessResponse,
  parseAuthTokenFromRequest,
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
  lang: "0001",
  code: {
    "1": {
      "elts": [
        JSON.stringify(data)
      ],
      "tag": "STR"
    },
    "2": {
      "elts": [
        1
      ],
      "tag": "JSON"
    },
    "root": 2
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
    const ids = [];
    EMPTY_OBJECT_ID =
      EMPTY_OBJECT_ID ||
      await postTasks({ auth, tasks: getTaskFromData({}), req });
    let data = await Promise.all(items.map(async item => {
      let { id, lang, code, data } = item;
      if (!id) {
        id = await postTasks({ auth, tasks: { lang, code }, req });
      }
      data = data || {};
      const tasks = getTaskFromData(data);
      const dataId = await postTasks({ auth, tasks: getTaskFromData(data), req });
      if (dataId !== EMPTY_OBJECT_ID && id.indexOf(dataId) < 0) {
        id = [id, dataId].join("+");
      }
      ids.push(id);
      return await getData({ auth, authToken, ids: [id] });
    }));
    if (data.length === 1) {
      data = data[0];
    }
    const [id] = ids;
    res.set("Access-Control-Allow-Origin", "*");
    res.status(200).json(createCompileSuccessResponse({ id, data }));
  });
};

export default ({ taskStorer, compileStorer, dataApi, compile }) => {
  const router = new Router();
  router.post("/", buildPostCompileHandler({ taskStorer, compileStorer, dataApi, compile }));
  router.options("/", optionsHandler);
  return router;
};
