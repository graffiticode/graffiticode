import EventEmitter from "events";
import errorHandler from "errorhandler";
import express from "express";
import methodOverride from "method-override";
import { createRequire } from "module";
import morgan from "morgan";
import cors from "cors";
import { fileURLToPath } from "url";
import { buildValidateToken } from "./auth.js";
import { buildCompile } from "./comp.js";
import { buildDataApi } from "./data.js";
import { compile as langCompile } from "./lang/index.js";
import * as routes from "./routes/index.js";
import { buildTaskDaoFactory } from "./storage/index.js";

const __filename = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);

// This line is required to ensure the typescript compiler moves the default
// config into the build directory.
// TODO(kevindyer) Refactor the creation of the app to inject the config
/* eslint-disable import/no-commonjs */
require("./../config/config.json");

EventEmitter.defaultMaxListeners = 15;

global.config = require(process.env.CONFIG || "./../config/config.json");
global.config.useLocalCompiles = process.env.LOCAL_COMPILES === "true";
console.log("global.config=" + JSON.stringify(global.config, null, 2));
const env = process.env.NODE_ENV || "development";

export const createApp = ({ authUrl } = {}) => {
  const compile = buildCompile({ langCompile });
  const taskDaoFactory = buildTaskDaoFactory();
  const dataApi = buildDataApi({ compile });

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
  app.use(express.json({ limit: "50mb" }));
  app.use(methodOverride());

  // Authentication
  const validateToken = buildValidateToken({ authUrl });
  app.use(routes.auth({ validateToken }));

  // Routes
  app.use("/", routes.root());
  app.use("/compile", routes.compile({ taskDaoFactory, dataApi, compile }));
  app.use("/config", routes.configHandler);
  app.use("/data", routes.data({ taskDaoFactory, dataApi }));
  app.use("/lang", routes.langRouter);
  app.use("/L*", routes.langRouter);
  app.use("/form", routes.formRouter({ taskDaoFactory }));
  app.use("/task", routes.tasks({ taskDaoFactory }));
  app.use("/tasks", routes.tasks({ taskDaoFactory }));

  // Error handling
  app.use((err, req, res, next) => {
    console.error(err);
    res.sendStatus(500);
  });

  return app;
};

const run = async () => {
  const port = global.port = process.env.PORT || 3100;
  const authUrl = process.env.AUTH_URL || "https://auth.graffiticode.org";
  const authProvider = process.env.AUTH_PROVIDER || "graffiticode";

  const app = createApp({ authUrl, authProvider });
  app.listen(port, () => {
    console.log(`Listening on ${port}...`);
  });

  process.on("uncaughtException", (err) => {
    console.log(`ERROR Caught exception: ${err.stack}`);
  });
};

const entryFile = process.argv?.[1];
if (entryFile === __filename) {
  run();
}
