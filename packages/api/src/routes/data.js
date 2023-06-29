import { Router } from "express";
import { InvalidArgumentError } from "../errors/http.js";

import {
  buildGetTaskDaoForId,
  buildGetCompileDaoForId,
  buildHttpHandler,
  createSuccessResponse,
  parseIdsFromRequest,
  parseAuthFromRequest,
  optionsHandler,
  buildCompileLogger
} from "./utils.js";

export const buildGetData = ({ getTaskDaoForId, getCompileDaoForId, dataApi }) => {
  const logCompile = buildCompileLogger();
  return async ({ auth, authToken, ids }) => {
    if (ids.length < 1) {
      throw new InvalidArgumentError("must provide at least one id");
    }
    const objs = await Promise.all(ids.map(id => dataApi.get({
      taskDao: getTaskDaoForId(id),
      compileDao: getCompileDaoForId(id),
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
    logCompile({
      token: authToken,
      id: ids.join(" "),
      status: "success",
      timestamp: String(Date.now()),
      data: JSON.stringify(data)
    });
    return data;
  };
};

const buildGetDataHandler = ({ taskDaoFactory, compileDaoFactory, dataApi }) => {
  const getTaskDaoForId = buildGetTaskDaoForId(taskDaoFactory);
  const getCompileDaoForId = buildGetCompileDaoForId(compileDaoFactory);
  const getData = buildGetData({ getTaskDaoForId, getCompileDaoForId, dataApi });
  return buildHttpHandler(async (req, res) => {
    const auth = req.auth.context;
    const authToken = parseAuthFromRequest(req);
    const ids = parseIdsFromRequest(req);
    const data = await getData({ auth, authToken, ids });
    res.status(200).json(createSuccessResponse(data));
  });
};

export default ({ taskDaoFactory, compileDaoFactory, dataApi }) => {
  const router = new Router();
  router.get("/", buildGetDataHandler({ taskDaoFactory, compileDaoFactory, dataApi }));
  router.options("/", optionsHandler);
  return router;
};
