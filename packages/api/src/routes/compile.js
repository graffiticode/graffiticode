import { Router } from "express";
import { buildPostTasks } from "./tasks.js";
import { buildGetData } from "./data.js";

import {
  buildGetTaskDaoForId,
  buildGetCompileDaoForId,
  buildHttpHandler,
  createSuccessResponse,
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

const getTaskFromData = data => ({ lang: "1", code: `data ${JSON.stringify(data)}..` });
let EMPTY_OBJECT_ID;

const buildPostCompileHandler = ({ taskDaoFactory, compileDaoFactory, dataApi }) => {
  const getTaskDaoForId = buildGetTaskDaoForId(taskDaoFactory);
  const getCompileDaoForId = buildGetCompileDaoForId(compileDaoFactory);
  const getData = buildGetData({ getTaskDaoForId, getCompileDaoForId, dataApi });
  return buildHttpHandler(async (req, res) => {
    const postTasks = buildPostTasks({ taskDaoFactory, req });
    const auth = req.auth.context;
    const authToken = parseAuthTokenFromRequest(req);
    const items = getItemsFromRequest(req);
    const ids = [];
    EMPTY_OBJECT_ID =
      EMPTY_OBJECT_ID ||
      await postTasks({ auth, tasks: getTaskFromData({}) });
    let data = await Promise.all(items.map(async item => {
      let { id, lang, code, data } = item;
      if (!id) {
        id = await postTasks({ auth, tasks: { lang, code } });
      }
      data = data || {};
      const dataId = await postTasks({ auth, tasks: getTaskFromData(data) });
      if (dataId !== EMPTY_OBJECT_ID && id.indexOf(dataId) < 0) {
        id = [id, dataId].join("+");
      }
      ids.push(id);
      return await getData({ auth, authToken, ids: [id] });
    }));
    if (data.length === 1) {
      data = data[0];
    }
    res.set("Access-Control-Allow-Origin", "*");
    res.status(200).json(createSuccessResponse({ ids, data }));
  });
};

export default ({ taskDaoFactory, compileDaoFactory, dataApi, compile }) => {
  const router = new Router();
  router.post("/", buildPostCompileHandler({ taskDaoFactory, compileDaoFactory, dataApi, compile }));
  router.options("/", optionsHandler);
  return router;
};
