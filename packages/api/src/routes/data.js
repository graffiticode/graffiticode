import { Router } from "express";
import { InvalidArgumentError } from "../errors/http.js";
import {
  buildHttpHandler,
  createSuccessResponse,
  parseIdsFromRequest,
  parseAuthFromRequest,
  optionsHandler,
  buildCompileLogger
} from "./utils.js";

export const buildGetData = ({ taskStorer, compileStorer, dataApi }) => {
  const logCompile = buildCompileLogger();
  return async ({ auth, authToken, ids }) => {
    if (ids.length < 1) {
      throw new InvalidArgumentError("must provide at least one id");
    }
    const action = {};
    const objs = await Promise.all(ids.map(id => dataApi.get({
      taskStorer, compileStorer, id, auth, authToken, action
    })));
    let data;
    if (objs.length > 1) {
      data = objs;
    } else {
      data = objs[0];
    }
    if (action.compiled) {
      logCompile({
        token: authToken,
        id: ids.join("+"),
        status: "success",
        timestamp: String(Date.now()),
        data: JSON.stringify(data)
      });
    }
    return data;
  };
};

const buildGetDataHandler = ({ taskStorer, compileStorer, dataApi }) => {
  const getData = buildGetData({ taskStorer, compileStorer, dataApi });
  return buildHttpHandler(async (req, res) => {
    const auth = req.auth.context;
    const authToken = parseAuthFromRequest(req);
    const ids = parseIdsFromRequest(req);
    const data = await getData({ auth, authToken, ids });
    res.status(200).json(createSuccessResponse({ data }));
  });
};

export default ({ taskStorer, compileStorer, dataApi }) => {
  const router = new Router();
  router.get("/", buildGetDataHandler({ taskStorer, compileStorer, dataApi }));
  router.options("/", optionsHandler);
  return router;
};
