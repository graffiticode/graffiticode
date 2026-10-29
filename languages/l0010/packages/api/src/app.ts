// SPDX-License-Identifier: MIT
import EventEmitter from "events";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { egressStatus } from "@graffiticode/l0000/egress";
import cors from "cors";
import morgan from "morgan";
import methodOverride from "method-override";
import errorHandler from "errorhandler";
import { buildValidateToken } from "./auth.js";
import { compile } from "./compile.js";
import * as routes from "./routes/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Public static assets + the /form embed bundle are assembled here by the root build.
const STATIC_DIR = path.join(__dirname, "..", "static");

EventEmitter.defaultMaxListeners = 15;
const env = process.env.NODE_ENV || "development";

export const createApp = ({ authUrl }: { authUrl?: string } = {}) => {
  const app = express();

  // Force HTTPS in production (except localhost).
  app.all("*", (req: Request, res: Response, next: NextFunction) => {
    const host = req.headers.host;
    if (
      host &&
      !/^localhost/.test(host) &&
      req.headers["x-forwarded-proto"] !== "https" &&
      env === "production"
    ) {
      res.redirect(["https://", host, req.url].join(""));
    } else {
      next();
    }
  });

  if (["development", "test"].includes(env)) {
    app.use(morgan("dev"));
    app.use(errorHandler());
  } else {
    app.use(morgan("combined", { skip: (_req, res) => res.statusCode < 400 }));
  }

  app.use(cors());
  // Let the /form embed bundle load inside COEP-isolated hosts (claude.ai / chatgpt.com
  // widget iframes). Without CORP the browser blocks the frame ("This content is blocked").
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    next();
  });
  app.use(express.json({ limit: "50mb" }));
  app.use(methodOverride());


  // PUBLIC static assets — lexicon.json, schema.json, spec.html, instructions.md,
  // language-info.json, usage-guide.md, scope.json, template.gc, and the /form bundle's
  // hashed assets. Mounted BEFORE auth so they require no token. `index: false` keeps
  // GET / as a health check rather than serving the embed index.html.
  app.use(express.static(STATIC_DIR, { index: false }));

  // Authentication: attaches req.auth (does not reject anonymous requests).
  const validateToken = buildValidateToken({ authUrl });
  app.use(routes.auth({ validateToken }));

  // ISOLATE-01: whether the egress proxy bootstrap is installed, and with which proxy. The
  // deploy CLI's candidate check reads it for a service with a network block.
  app.get("/egress", (_req: Request, res: Response) => {
    res.json(egressStatus() ?? { installed: false, httpsProxy: null, httpProxy: null, noProxy: null });
  });

  // Routes
  app.use("/", routes.root());
  app.use("/compile", routes.compile({ compile }));
  app.get("/form", (_req: Request, res: Response) => {
    res.sendFile(path.join(STATIC_DIR, "index.html"));
  });

  // Error handling
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.sendStatus(500);
  });

  return app;
};
