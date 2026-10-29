import { Router } from "express";
import { InvalidArgumentError, NotFoundError } from "../errors/http.js";
import { allInGenerationLang, getActiveGeneration, getLanguageGenerations, languageGenerationSuffix, GENERATION_LANG } from "../generation.js";
import { buildGetTasks } from "./tasks.js";
import {
  buildHttpHandler,
  parseIdsFromRequest,
  parseOriginFromRequest,
  parseConnectionId,
  parsePublicationId,
} from "./utils.js";

// The language whose View renders L0158 items once a generation is active.
const RENDER_LANG = "0176";

const checkLangParam = async ({ lang, pingLang, uid }) => {
  if (/^\d+$/.test(lang)) {
    lang = `L${lang}`;
  }
  if (!/^[Ll]\d+$/.test(lang)) {
    throw new InvalidArgumentError(`Invalid lang ${lang}`);
  }
  if (!await pingLang(lang, { uid })) {
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
    const origin = parseOriginFromRequest(req);
    if (origin) {
      params.set("origin", origin);
    }
    // A view through a connection (the caller's stored result) or of a
    // publication. The View reads these from its own URL for its data load.
    const connection = parseConnectionId(req.query.connection, { auth: req.auth.context });
    const publication = parsePublicationId(req.query.publication);
    if (connection && publication) {
      throw new InvalidArgumentError("choose a connection or a publication, not both");
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
      if (connection) {
        params.set("connection", connection);
        dataParams.set("connection", connection);
      }
      if (publication) {
        params.set("publication", publication);
        dataParams.set("publication", publication);
      }
      const auth = req.auth.context;
      // @ts-expect-error TS-MIGRATE: checkJs infers a destructured parameter's type from its default; optional fields read as missing
      const tasks = await getTasks({ auth, ids, req });
      lang = tasks[0].lang;
      // With a compile generation active, an L0158 item renders in L0176's
      // View, which signs its preview through Broker for L0176's host, and
      // reads the item's data under that generation (generation.js). Unset,
      // nothing changes.
      const generation = getActiveGeneration();
      if (generation && allInGenerationLang(tasks)) {
        // L0158 isn't connectable; a connection must not reach L0176's View
        // with an L0158 item.
        if (connection) {
          throw new InvalidArgumentError(`L${GENERATION_LANG} items can't be viewed through a connection`);
        }
        lang = RENDER_LANG;
        dataParams.set("generation", generation);
      }
      // The switch generations the item's data is answered under (B4), so the
      // data URL names its namespace and a new one is a new URL. None set, the
      // URL is as before.
      const suffix = languageGenerationSuffix(tasks, getLanguageGenerations());
      if (suffix) {
        dataParams.set("generations", suffix);
      }
      params.set("id", id);
      params.set("url", `${protocol}://${req.headers.host}/data?${dataParams.toString()}`);
    } else {
      throw new InvalidArgumentError("Missing or invalid parameters");
    }
    const uid = req.auth?.uid;
    lang = await checkLangParam({ lang, pingLang, uid });
    const baseUrl = await getBaseUrlForLanguage(lang, { uid });
    const formUrl = `${baseUrl}/form?${params.toString()}`;
    res.redirect(formUrl);
  });
};

export const buildFormRouter = ({ pingLang, getBaseUrlForLanguage }) => ({ taskStorer }) => {
  // @ts-expect-error TS-MIGRATE: express Router is callable; its types reject `new`
  const router = new Router();
  router.get("/", buildGetFormHandler({ pingLang, getBaseUrlForLanguage })({ taskStorer }));
  return router;
};
