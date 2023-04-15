import { Router } from "express";
import { buildPostTasks } from "./tasks.js";
import { buildGetData } from "./data.js";

import {
  buildGetTaskDaoForId,
  buildHttpHandler,
  createSuccessResponse,
  parseAuthFromRequest,
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

const getTaskFromData = data => ({ lang: "1", code: `${JSON.stringify(data)}..` });

const buildPostCompileHandler = ({ taskDaoFactory, dataApi, compile }) => {
  const getTaskDaoForId = buildGetTaskDaoForId(taskDaoFactory);
  const getData = buildGetData({ getTaskDaoForId, dataApi });
  return buildHttpHandler(async (req, res) => {
    const postTasks = buildPostTasks({ taskDaoFactory, req });
    const auth = req.auth.context;
    const authToken = parseAuthFromRequest(req);
    const items = getItemsFromRequest(req);
    let data = await Promise.all(items.map(async item => {
      let { id, lang, code, data } = item;
      if (!id) {
        id = await postTasks({ auth, tasks: { lang, code } });
      }
      data = data || {};
      const dataId = await postTasks({ auth, tasks: getTaskFromData(data) });
      const taskId = [id, dataId].join("+");
      return await getData({ auth, authToken, ids: [taskId] });
    }));
    if (data.length === 1) {
      data = data[0];
    }
    res.set("Access-Control-Allow-Origin", "*");
    res.status(200).json(createSuccessResponse(data));
  });
};

export default ({ taskDaoFactory, dataApi, compile }) => {
  const router = new Router();
  router.post("/", buildPostCompileHandler({ taskDaoFactory, dataApi, compile }));
  router.options("/", optionsHandler);
  return router;
};
