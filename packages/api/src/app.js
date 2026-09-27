import EventEmitter from "events";
import errorHandler from "errorhandler";
import express from "express";
import methodOverride from "method-override";
import { createRequire } from "module";
import morgan from "morgan";
import cors from "cors";
import { buildValidateToken } from "./auth.js";
import { buildCompile } from "./comp.js";
import { buildDataApi } from "./data.js";
import { buildAllocateInvocation, buildMetadataIdToken } from "./invocations.js";
import { buildPublicationClient } from "./publications.js";
import { compile as langCompile, validateOutput } from "./lang/index.js";
import * as routes from "./routes/index.js";
import { createStorers } from "./storage/index.js";

const require = createRequire(import.meta.url);

// This line is required to ensure the typescript compiler moves the default
// config into the build directory.
// TODO(kevindyer) Refactor the creation of the app to inject the config
/* eslint-disable import/no-commonjs */
require("./../config/config.json");

EventEmitter.defaultMaxListeners = 15;

global.config = require(process.env.CONFIG || "./../config/config.json");
global.config.useLocalCompiles = process.env.LOCAL_COMPILES === "true";
const env = process.env.NODE_ENV || "development";

export const createApp = ({ authUrl } = {}) => {
  const compile = buildCompile({ langCompile });
  const { taskStorer, compileStorer, langOverrideStorer, artifactStorer } = createStorers();
  // POLICY_URL (the policy service's run.app URL) enables compiles through a
  // selected connection; without it they are refused, never run unguarded.
  const policyUrl = process.env.POLICY_URL;
  const idToken = policyUrl ? buildMetadataIdToken() : null;
  const allocateInvocation = policyUrl ? buildAllocateInvocation({ policyUrl, idToken }) : null;
  const publications = policyUrl ? buildPublicationClient({ policyUrl, idToken }) : null;
  const dataApi = buildDataApi({ compile, langOverrideStorer, validateOutput, allocateInvocation, artifactStorer, publications });

  const app = express();
  app.all("*", (req, res, next) => {
    if (req.headers.host.match(/^localhost/) === null) {
      if (req.headers["x-forwarded-proto"] !== "https" && env === "production") {
        console.log("app.all redirecting headers=" + JSON.stringify(req.headers, null, 2) + " url=" + req.url);
        res.redirect(["https://", req.headers.host, req.url].join(""));
      } else {
        next();
      }
    } else {
      next();
    }
  });

  if (["development", "test"].includes(env)) {
    app.use(morgan("dev"));
    app.use(errorHandler({ dumpExceptions: true, showStack: true }));
  } else {
    app.use(morgan("combined", {
      skip: (req, res) => res.statusCode < 400
    }));
  }
  app.use(cors());
  // Let the /form redirect (and any embedded response) load inside COEP-isolated
  // hosts (claude.ai / chatgpt.com widget iframes). Without CORP the browser blocks
  // the frame ("This content is blocked") at this first hop before the l0NNN redirect.
  app.use((_req, res, next) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    next();
  });
  app.use(express.json({ limit: "50mb" }));
  app.use(methodOverride());

  // Authentication
  const validateToken = buildValidateToken({ authUrl });
  app.use(routes.auth({ validateToken }));

  // Routes
  app.use("/", routes.root());
  app.use("/compile", routes.compile({ taskStorer, compileStorer, dataApi }));
  app.use("/config", routes.configHandler);
  app.use("/data", routes.data({ taskStorer, compileStorer, dataApi }));
  app.use("/lang-overrides", routes.langOverrides({ langOverrideStorer }));
  app.use("/lang", routes.langRouter);
  app.use("/L*", routes.langRouter);
  app.use("/form", routes.formRouter({ taskStorer }));
  app.use("/task", routes.tasks({ taskStorer }));
  app.use("/tasks", routes.tasks({ taskStorer }));
  app.use("/publications", routes.publications({ taskStorer, artifactStorer, publications }));

  // Error handling
  app.use((err, req, res, next) => {
    console.error(err);
    res.sendStatus(500);
  });

  return app;
};
