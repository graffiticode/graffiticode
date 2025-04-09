import { Router } from "express";
import { InvalidArgumentError } from "../errors/http.js";
import { parser } from "@graffiticode/parser";
// import { parser } from "../../../parser/src/index.js";
import { isNonEmptyString } from "../util.js";
import {
  getStorageTypeForRequest,
  buildHttpHandler,
  createSuccessResponse,
  parseIdsFromRequest,
  optionsHandler
} from "./utils.js";

const normalizeTasksParameter = async tasks => {
  tasks = !Array.isArray(tasks) && [tasks] || tasks;
  tasks = await Promise.all(tasks.map(async (task) => {
    if (isNonEmptyString(task.code)) {
      const { lang, code } = task;
      task = { lang, code: await parser.parse(lang, code) };
    }
    return task;
  }));
  return tasks;
};

const getIdFromIds = ids => {
  if (ids.length === 1) {
    return ids[0];
  } else {
    return ids;
  }
};

export const buildGetTasks = ({ taskStorer }) => {
  return async ({ auth, ids }) => {
    if (ids.length < 1) {
      throw new InvalidArgumentError("must provide at least one task id");
    }
    const tasksForIds = await Promise.all(ids.map(id => {
      return taskStorer.get({ id, auth });
    }));
    const tasks = tasksForIds.reduce((tasks, tasksForId) => {
      tasks.push(...tasksForId);
      return tasks;
    }, []);
    return tasks;
  };
};

const buildGetTaskHandler = ({ taskStorer }) => {
  const getTasks = buildGetTasks({ taskStorer });
  return buildHttpHandler(async (req, res) => {
    const auth = req.auth.context;
    const ids = parseIdsFromRequest(req);
    if (ids.length < 1) {
      throw new InvalidArgumentError("must provide at least one id");
    }
    const tasks = await getTasks({ auth, ids });
    res.status(200).json(createSuccessResponse({ data: tasks }));
  });
};

export const buildPostTasks = ({ taskStorer }) => {
  return async ({ auth, tasks, req }) => {
    tasks = await normalizeTasksParameter(tasks);
    if (tasks.length < 1) {
      throw new InvalidArgumentError("must provide at least one task");
    }
    const storageType = getStorageTypeForRequest(req);
    const ids = await Promise.all(tasks.map(task => taskStorer.create({ auth, task, storageType })));
    const id = getIdFromIds(ids);
    return id;
  };
};

const buildPostTaskHandler = ({ taskStorer }) => {
  const postTasks = buildPostTasks({ taskStorer });
  return buildHttpHandler(async (req, res) => {
    const auth = req.auth.context;
    const tasks = req.body.tasks || req.body.task;
    const ids = await postTasks({ auth, tasks, req });
    res.status(200).json(createSuccessResponse({ data: { id: ids } }));
  });
};

export default ({ taskStorer }) => {
  const router = new Router();
  router.get("/", buildGetTaskHandler({ taskStorer }));
  router.post("/", buildPostTaskHandler({ taskStorer }));
  router.options("/", optionsHandler);
  return router;
};
