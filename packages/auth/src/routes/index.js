import cors from "cors";
import express from "express";
import morgan from "morgan";

import { buildAuthenticateRouter } from "./authenticate.js";
import { buildCertsRouter } from "./certs.js";
import { buildOAuthRouter } from "./oauth.js";

export const createApp = deps => {
  const app = express();
  app.use(morgan("dev"));
  app.use(cors());
  app.use(express.json({ limit: "50mb" }));

  // Routes
  app.get("/", (req, res) => res.sendStatus(200));
  app.use("/authenticate", buildAuthenticateRouter(deps));
  app.use("/oauth", buildOAuthRouter(deps));
  app.use("/certs", buildCertsRouter(deps));

  // Handle errors
  app.use((err, req, res, next) => {
    console.error(err.stack);
    res.sendStatus(500);
  });

  return app;
};
