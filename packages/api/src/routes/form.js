import { Router } from "express";
import { InvalidArgumentError, NotFoundError } from "../errors/http.js";
import { isNonEmptyString } from "../util.js";
import { buildGetTasks } from "./tasks.js";
import {
  buildHttpHandler,
  optionsHandler,
  parseIdsFromRequest,
} from "./utils.js";

const checkLangParam = async ({ lang, pingLang }) => {
  if (/^\d+$/.test(lang)) {
    lang = `L${lang}`;
  }
  if (!/^[Ll]\d+$/.test(lang)) {
    throw new InvalidArgumentError(`Invalid lang ${lang}`);
  }
  if (!await pingLang(lang)) {
    throw new NotFoundError(`Language not found ${lang}`);
  }
  return lang;
};

const buildGetFormHandler = ({ pingLang, getBaseUrlForLanguage }) => ({ taskStorer }) => {
  const getTasks = buildGetTasks({ taskStorer });
  return buildHttpHandler(async (req, res) => {
    const ids = parseIdsFromRequest(req);
    const params = new URLSearchParams();
    if (req.auth.token) {
      params.set("access_token", req.auth.token);
    }
    const protocol = req.headers.host.indexOf("localhost") !== -1 && "http" || "https";
    let lang;
    if (ids.length === 1) {
      const id = ids[0];
      const dataParams = new URLSearchParams();
      dataParams.set("id", id);
      if (req.auth.token) {
        dataParams.set("access_token", req.auth.token);
      }
      const auth = req.auth.context;
      const tasks = await getTasks({ auth, ids, req });
      lang = tasks[0].lang;
      params.set("id", id);
      params.set("url", `${protocol}://${req.headers.host}/data?${dataParams.toString()}`);
    } else {
      throw new InvalidArgumentError("Missing or invalid parameters");
    }
    lang = await checkLangParam({ lang, pingLang });
    const baseUrl = getBaseUrlForLanguage(lang);
    const formUrl = `${baseUrl}/form?${params.toString()}`;
    res.redirect(formUrl);
  });
};

export const buildFormRouter = ({ pingLang, getBaseUrlForLanguage }) => ({ taskStorer }) => {
  const router = new Router();
  router.get("/", buildGetFormHandler({ pingLang, getBaseUrlForLanguage })({ taskStorer }));
  router.options("/", optionsHandler);
  return router;
};
