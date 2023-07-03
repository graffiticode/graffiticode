import { Router } from "express";
import { InvalidArgumentError } from "../errors/http.js";
import { parser } from "../lang/parser.js";
import { isNonEmptyString } from "../util.js";
import {
  getStorageTypeForRequest,
  buildGetTaskDaoForRequest,
  buildGetTaskDaoForId,
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

export const buildGetTasks = ({ taskDaoFactory }) => {
  const getTaskDaoForId = buildGetTaskDaoForId(taskDaoFactory);
  return async ({ auth, ids }) => {
    if (ids.length < 1) {
      throw new InvalidArgumentError("must provide at least one task id");
    }
    const tasksForIds = await Promise.all(ids.map(id => {
      const taskDao = getTaskDaoForId(id);
      return taskDao.get({ id, auth });
    }));
    const tasks = tasksForIds.reduce((tasks, tasksForId) => {
      tasks.push(...tasksForId);
      return tasks;
    }, []);
    return tasks;
  };
};

const buildGetTaskHandler = ({ taskDaoFactory }) => {
  return buildHttpHandler(async (req, res) => {
    const getTasks = buildGetTasks({ taskDaoFactory });
    const auth = req.auth.context;
    const ids = parseIdsFromRequest(req);
    if (ids.length < 1) {
      throw new InvalidArgumentError("must provide at least one id");
    }
    const tasks = await getTasks({ auth, ids });
    res.status(200).json(createSuccessResponse({ ids, data: tasks }));
  });
};

export const buildPostTasks = ({ taskDaoFactory, req }) => {
  const getTaskDaoForRequest = buildGetTaskDaoForRequest(taskDaoFactory);
  return async ({ auth, tasks }) => {
    tasks = await normalizeTasksParameter(tasks);
    if (tasks.length < 1) {
      throw new InvalidArgumentError("must provide at least one task");
    }
    const taskDao = getTaskDaoForRequest(req);
    const storageType = getStorageTypeForRequest(req);
    const ids = await Promise.all(tasks.map(task => taskDao.create({ auth, task, storageType })));
    const id = getIdFromIds(ids);
    return id;
  };
};

const buildPostTaskHandler = ({ taskDaoFactory }) => {
  return buildHttpHandler(async (req, res) => {
    const postTasks = buildPostTasks({ taskDaoFactory, req });
    const auth = req.auth.context;
    const tasks = req.body.tasks || req.body.task;
    const ids = await postTasks({ auth, tasks });
    res.status(200).json(createSuccessResponse({ ids, data: { id: ids } }));
  });
};

export default ({ taskDaoFactory }) => {
  const router = new Router();
  router.get("/", buildGetTaskHandler({ taskDaoFactory }));
  router.post("/", buildPostTaskHandler({ taskDaoFactory }));
  router.options("/", optionsHandler);
  return router;
};
