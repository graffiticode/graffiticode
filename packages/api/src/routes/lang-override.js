import { Router } from "express";
import {
  buildHttpHandler,
  createSuccessResponse,
  optionsHandler
} from "./utils.js";

// Reports which languages the authenticated caller has a per-user binding
// override for. The console uses this to decide, per language, whether its
// local asset caches are safe to use: an overridden language redirects to a
// test revision, so its cached value must not be shared with the default
// binding. Returns only the lang keys (e.g. ["L0175"]) — never the override
// URLs, which stay server-side. Anonymous callers get an empty list.
const buildGetLangOverridesHandler = ({ langOverrideStorer }) =>
  buildHttpHandler(async (req, res) => {
    const uid = req.auth?.uid;
    const override = uid ? await langOverrideStorer.get({ uid }) : undefined;
    const langs = override?.bindings
      ? Object.keys(override.bindings).map(k => k.toUpperCase())
      : [];
    res.set("Access-Control-Allow-Origin", "*");
    res.status(200).json(createSuccessResponse({ data: { langs } }));
  });

export default ({ langOverrideStorer }) => {
  const router = new Router();
  router.get("/", buildGetLangOverridesHandler({ langOverrideStorer }));
  router.options("/", optionsHandler);
  return router;
};
