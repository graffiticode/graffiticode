import { Router } from "express";
import { InvalidArgumentError } from "../errors/http.js";

import {
  buildGetTaskDaoForId,
  buildHttpHandler,
  createSuccessResponse,
  parseIdsFromRequest,
  parseAuthFromRequest,
  optionsHandler,
  buildCompileLogger
} from "./utils.js";

export const buildGetData = ({ getTaskDaoForId, dataApi }) => {
  const logCompile = buildCompileLogger();
  return async ({ auth, authToken, ids }) => {
    if (ids.length < 1) {
      throw new InvalidArgumentError("must provide at least one id");
    }
    const objs = await Promise.all(ids.map(id => dataApi.get({
      taskDao: getTaskDaoForId(id),
      id,
      auth,
      authToken
    })));
    let data;
    if (objs.length > 1) {
      data = objs;
    } else {
      data = objs[0];
    }
    console.log("getData() data=" + JSON.stringify(data, null, 2));
    logCompile({
      token: authToken,
      id: ids.join(" "),
      status: "success",
      timestamp: String(Date.now()),
      data
    });
    return data;
  };
};

const buildGetDataHandler = ({ taskDaoFactory, dataApi }) => {
  const getTaskDaoForId = buildGetTaskDaoForId(taskDaoFactory);
  const getData = buildGetData({ getTaskDaoForId, dataApi });
  return buildHttpHandler(async (req, res) => {
    const auth = req.auth.context;
    const authToken = parseAuthFromRequest(req);
    const ids = parseIdsFromRequest(req);
    const data = await getData({ auth, authToken, ids });
    res.status(200).json(createSuccessResponse(data));
  });
};

export default ({ taskDaoFactory, dataApi }) => {
  const router = new Router();
  router.get("/", buildGetDataHandler({ taskDaoFactory, dataApi }));
  router.options("/", optionsHandler);
  return router;
};
