import { Router } from "express";
import { buildCertsRouter } from "../certs.js";
import { buildApiKeysRouter } from "./api-keys.js";
import { buildEthereumRouter } from "./ethereum.js";

export const buildV1Router = (deps) => {
  const router = new Router();

  router.use("/api-keys", buildApiKeysRouter(deps));
  router.use("/certs", buildCertsRouter(deps));
  router.use("/ethereum", buildEthereumRouter(deps));

  return router;
};
