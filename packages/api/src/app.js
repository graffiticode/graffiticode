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
import { createApiAudit } from "./audit.js";
import { buildCallerIdentity } from "./caller-identity.js";
import { buildSigningLimiter, parseSigningLimitConfig } from "./signing-limit.js";
import { requestContextMiddleware } from "@graffiticode/policy/audit";
import { buildAllocateInvocation, buildMetadataIdToken } from "./invocations.js";
import { buildPublicationClient } from "./publications.js";
import { buildLang } from "./lang/index.js";
import { buildChainAdmission, parseChainAdmission } from "./admission.js";
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

// @ts-expect-error TS-MIGRATE: checkJs infers a destructured parameter's type from its default; optional fields read as missing
// Tests may supply `validateToken`, `callerIdToken` (the api's ID-token
// minter for compiles, caller-identity.js), `audit` and `signingLimiter`.
export const createApp = ({ authUrl, validateToken: givenValidateToken, callerIdToken, audit: givenAudit, signingLimiter: givenLimiter } = {}) => {
  const { taskStorer, compileStorer, langOverrideStorer, artifactStorer } = createStorers();
  const { compile: langCompile, validateOutput, getBaseUrlForLanguage, getLangAsset, pingLang } = buildLang({ langOverrideStorer });
  // POLICY_URL (the policy service's run.app URL) enables compiles through a
  // selected connection; without it they are refused, never run unguarded.
  const policyUrl = process.env.POLICY_URL;
  const idToken = policyUrl ? buildMetadataIdToken() : null;
  // Every compile to L0176 carries the api's identity (caller-identity.js),
  // minted like preflight's. On Cloud Run (K_SERVICE) the metadata server
  // mints it even without POLICY_URL; locally there is none, and compiles go
  // without it.
  const identityMinter = callerIdToken !== undefined
    ? callerIdToken
    : (idToken ?? (process.env.K_SERVICE ? buildMetadataIdToken() : null));
  const compile = buildCompile({ langCompile, callerIdentity: buildCallerIdentity({ idToken: identityMinter }) });
  const allocateInvocation = policyUrl ? buildAllocateInvocation({ policyUrl, idToken }) : null;
  const publications = policyUrl ? buildPublicationClient({ policyUrl, idToken }) : null;
  // Chain admission (capability plan W4): CHAIN_ADMISSION decides which new
  // invocations are allocated for it; a marked one always takes it. Compilers
  // are resolved without any user's override.
  const chainAdmissionMode = parseChainAdmission(process.env);
  const chainAdmission = policyUrl
    ? buildChainAdmission({ policyUrl, idToken, baseUrlFor: lang => getBaseUrlForLanguage(`L${String(lang).replace(/^L/i, "")}`) })
    : null;
  // Security audit, without user identifiers (audit.js).
  const audit = givenAudit ?? createApiAudit();
  // The per-client limit on system preview signing (signing-limit.js).
  const signingLimiter = givenLimiter ?? buildSigningLimiter({ ...parseSigningLimitConfig(process.env), audit });
  const dataApi = buildDataApi({
    compile,
    langOverrideStorer,
    validateOutput,
    allocateInvocation,
    artifactStorer,
    publications,
    audit,
    chainAdmission,
    admissionWanted: chainAdmissionMode.wants,
  });

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
  // /preview/sign holds its body to its own, smaller cap (routes/preview.js).
  app.use("/preview/sign", routes.previewSignBodyParser);
  app.use(express.json({ limit: "50mb" }));
  // Every audit record written while handling a request names it.
  app.use(requestContextMiddleware);
  app.use(methodOverride());

  // Authentication
  const validateToken = givenValidateToken ?? buildValidateToken({ authUrl });
  app.use(routes.auth({ validateToken }));

  // Routes
  app.use("/", routes.root());
  app.use("/compile", routes.compile({ taskStorer, compileStorer, dataApi, signingLimiter }));
  app.use("/config", routes.configHandler);
  app.use("/data", routes.data({ taskStorer, compileStorer, dataApi, signingLimiter }));
  app.use("/preview", routes.preview({ compile, signingLimiter }));
  app.use("/lang-overrides", routes.langOverrides({ langOverrideStorer }));
  const langRouter = routes.buildLangRouter({ pingLang, getLangAsset });
  app.use("/lang", langRouter);
  app.use("/L*", langRouter);
  app.use("/form", routes.buildFormRouter({ pingLang, getBaseUrlForLanguage })({ taskStorer }));
  app.use("/task", routes.tasks({ taskStorer }));
  app.use("/tasks", routes.tasks({ taskStorer }));
  app.use("/publications", routes.publications({ taskStorer, artifactStorer, publications }));

  // Error handling
  app.use((err, req, res, next) => {
    console.error(err);
    res.set("Cache-Control", "no-store");
    res.sendStatus(500);
  });

  return app;
};
