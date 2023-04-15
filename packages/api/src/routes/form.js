import { Router } from "express";
import { InvalidArgumentError, NotFoundError } from "../errors/http.js";
import { isNonEmptyString } from "../util.js";
import { buildHttpHandler, optionsHandler } from "./utils.js";
import { buildGetTasks } from "./tasks.js";

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

const buildGetFormHandler = ({ pingLang, getBaseUrlForLanguage }) => ({ taskDaoFactory }) => {
  return buildHttpHandler(async (req, res) => {
    let { id, lang, data } = req.query;
    const params = new URLSearchParams();
    if (req.auth.token) {
      params.set("access_token", req.auth.token);
    }
    const protocol = req.headers.host.indexOf("localhost") !== -1 && "http" || "https";
    if (isNonEmptyString(id)) {
      const dataParams = new URLSearchParams();
      dataParams.set("id", id);
      if (req.auth.token) {
        dataParams.set("access_token", req.auth.token);
      }
      const getTasks = buildGetTasks({ taskDaoFactory, req });
      const auth = req.auth.context;
      const tasks = await getTasks({ auth, ids: [id] });
      lang = tasks[0].lang;
      params.set("url", `${protocol}://${req.headers.host}/data?${dataParams.toString()}`);
    } else if (isNonEmptyString(data)) {
      params.set("data", data);
    } else {
      throw new InvalidArgumentError("Missing or invalid parameters");
    }
    lang = await checkLangParam({ lang, pingLang });
    const baseUrl = getBaseUrlForLanguage(lang);
    const formUrl = `${baseUrl}/form?${params.toString()}`;
    console.log("getFormHandler() formUrl=" + formUrl);
    res.redirect(formUrl);
  });
};

export const buildFormRouter = ({ pingLang, getBaseUrlForLanguage }) => ({ taskDaoFactory }) => {
  const router = new Router();
  router.get("/", buildGetFormHandler({ pingLang, getBaseUrlForLanguage })({ taskDaoFactory }));
  router.options("/", optionsHandler);
  return router;
};
