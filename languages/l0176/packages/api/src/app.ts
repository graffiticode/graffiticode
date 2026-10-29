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
import { compiler } from "@graffiticode/l0176";
import { createGatewayVerifier, createPreflightHandler } from "@graffiticode/l0000";
import * as routes from "./routes/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Public static assets + the /form embed bundle are assembled here by the root build.
const STATIC_DIR = path.join(__dirname, "..", "static");

EventEmitter.defaultMaxListeners = 15;
const env = process.env.NODE_ENV || "development";

// SYSTEM_PREVIEW_DIRECT=1, and only exactly "1", lets a direct caller (no
// verified api identity) have a no-connection preview signed on the system
// path: for the gateway-only rollout window only (plan
// system-preview-rate-limit). Anything else leaves the gate on.
export const systemPreviewDirect = (env: NodeJS.ProcessEnv = process.env): boolean => env.SYSTEM_PREVIEW_DIRECT === "1";

// `preflightGateways`: the gateway service accounts allowed to preflight
// (capability plan W4), and the only callers whose no-connection compiles are
// signed on the system path (gateway-only). With none, every preflight is
// refused and, unless `systemPreviewDirect`, every no-connection preview goes
// out unsigned.
export const createApp = ({
  authUrl,
  preflightGateways = [],
  verifyCaller,
  systemPreviewDirect: direct = false,
}: {
  authUrl?: string;
  preflightGateways?: string[];
  verifyCaller?: (headers: Record<string, unknown>) => Promise<unknown>;
  systemPreviewDirect?: boolean;
} = {}) => {
  const app = express();
  // One verifier for both: the api's ID token, audience urn:graffiticode:0176,
  // for a PREFLIGHT_GATEWAYS account.
  const verifyGateway = verifyCaller ?? createGatewayVerifier({ lang: "0176", gateways: preflightGateways });

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

  // Preflight (capability plan W4): the gateway only, authenticated by the
  // route itself (@graffiticode/l0000 preflight-route), side-effect free.
  // Before the user-token middleware: it reads no user token.
  const preflight = createPreflightHandler({
    compiler,
    verifyCaller: verifyGateway,
  });
  app.post("/preflight", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await preflight({ headers: req.headers as Record<string, unknown>, body: req.body });
      res.set("Cache-Control", "no-store");
      res.status(out.status).json(out.body);
    } catch (err) {
      next(err);
    }
  });

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
  app.use("/compile", routes.compile({ compile, verifyGateway, systemPreviewDirect: direct }));
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
