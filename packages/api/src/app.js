import EventEmitter from "events";
import errorHandler from "errorhandler";
import express from "express";
import { randomUUID } from "node:crypto";
import methodOverride from "method-override";
import { createRequire } from "module";
import morgan from "morgan";
import cors from "cors";
import { buildValidateToken } from "./auth.js";
import { buildModelCache, parseModelCacheConfig } from "./model-cache.js";
import { cacheVerifications } from "@graffiticode/common/verified-tokens";
import { buildCompile, buildInterpreter, buildCommandStart, buildCommandMaterialize } from "./comp.js";
import { materializeCommand } from "./commands/records.js";
import { ARTIFACT_RESULT_FORM } from "./read.js";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import { buildPolicyCommands } from "./commands/policy-commands.js";
import { buildCommandWorker } from "./commands/worker.js";
import { parseCommandFaults } from "./commands/faults.js";
import { buildCommandRouter } from "./routes/command.js";
import { buildSweep, buildSweepAuthorizer, parseSweepConfig } from "./commands/sweep.js";
import { buildCommandEnvelope } from "./commands/dispatch.js";
import { buildEligibility, buildCompileEnvelope, buildCommandBridge } from "./commands/bridge.js";
import { buildGetData as buildRouteGetData } from "./routes/data.js";
import { buildGoogleIdTokenVerifier } from "@graffiticode/common/caller";
import { OAuth2Client } from "google-auth-library";
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
  const { taskStorer, compileStorer, langOverrideStorer, artifactStorer, stageResultStorer } = createStorers();
  const { compile: langCompile, validateOutput, getBaseUrlForLanguage, getPublicBaseUrlForLanguage, getLangAsset, pingLang } = buildLang({ langOverrideStorer });
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
  const callerIdentity = buildCallerIdentity({ idToken: identityMinter });
  const compile = buildCompile({ langCompile, callerIdentity });
  // The interpreter pass (plan B3): used only for languages declared in the
  // interpreter manifest and turned on with INTERPRETER_LNNNN.
  const interpreter = buildInterpreter({ langCompile, callerIdentity });
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
  // Interpreted stages' models, per instance (model-cache.js); MODEL_CACHE_TTL_MS=0 turns it off.
  const modelCacheConfig = parseModelCacheConfig(process.env);
  const modelCache = modelCacheConfig.enabled ? buildModelCache({ ttlMs: modelCacheConfig.ttlMs, max: modelCacheConfig.max }) : null;
  // Commands (B5): Policy's command routes, when Policy is configured.
  const policyCommands = policyUrl ? buildPolicyCommands({ policyUrl, idToken }) : null;
  // C6 (D2): the one eligibility rule both routes use, and the compile bridge.
  // The bridge reaches the worker through `commandRunner`, built below.
  let commandRunner = null;
  const eligible = chainAdmission
    ? buildEligibility({ preflight: chainAdmission.preflight, baseUrlFor: chainAdmission.baseUrlFor })
    : null;
  const compileEnvelope = policyCommands ? buildCompileEnvelope({ policy: policyCommands }) : null;
  const commandBridge = policyCommands && eligible
    ? buildCommandBridge({ eligible, getRunner: () => commandRunner, compileEnvelope })
    : null;
  const dataApi = buildDataApi({
    // D2a: a command's key on /compile is answered from its record.
    commandEnvelope: policyCommands ? buildCommandEnvelope({ policy: policyCommands }) : null,
    commandBridge,
    compile,
    langOverrideStorer,
    validateOutput,
    allocateInvocation,
    artifactStorer,
    publications,
    audit,
    chainAdmission,
    admissionWanted: chainAdmissionMode.wants,
    interpreter,
    stageResults: stageResultStorer,
    modelCache,
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

  // The command worker (B5): its Policy client, its run, and this instance's
  // name in leases. Only with Policy.
  const commandWorker = policyCommands
    ? (() => {
        const worker = `${process.env.K_REVISION ?? "api"}:${randomUUID()}`;
        const commandMaterialize = buildCommandMaterialize({ langCompile, callerIdentity });
        const run = buildCommandWorker({
          policy: policyCommands,
          taskStorer,
          artifactStorer,
          worker,
          // C6's drive only, and never on the production service (faults.js).
          faults: parseCommandFaults(),
          language: {
            baseUrlFor: lang => getBaseUrlForLanguage(`L${String(lang).replace(/^L/i, "")}`),
            model: interpreter.model,
            interpret: interpreter.interpret,
            start: buildCommandStart({ langCompile, callerIdentity }),
            materialize: commandMaterialize,
            preflight: chainAdmission.preflight,
          },
        });
        commandRunner = { policy: policyCommands, run, worker };
        // B6 (decision 9): a command rebuilt from its records, as its artifact.
        const materialize = ({ commandId }) => materializeCommand({
          policy: policyCommands,
          language: { materialize: commandMaterialize },
          artifactStorer,
          commandId,
          registryVersion: REGISTRY_VERSION,
          form: ARTIFACT_RESULT_FORM,
          log: line => console.log(line),
        });
        return { policy: policyCommands, run, worker, materialize };
      })()
    : null;
  // Recovery of abandoned commands (B5 §7): Cloud Scheduler, with its own ID
  // token, before user authentication (its token isn't a user's). Mounted only
  // with SWEEP_AUDIENCE and SWEEP_CALLERS.
  const sweepConfig = parseSweepConfig(process.env);
  if (commandWorker && sweepConfig) {
    const authorized = buildSweepAuthorizer({ verifyIdToken: buildGoogleIdTokenVerifier({ OAuth2Client }), ...sweepConfig });
    const sweep = buildSweep({ policy: commandWorker.policy, run: commandWorker.run, worker: commandWorker.worker });
    app.post("/internal/commands/sweep", async (req, res) => {
      if (!(await authorized(req))) {
        res.status(401).json({ status: "error", error: { code: 401, message: "not the scheduler" }, data: null });
        return;
      }
      try {
        res.status(200).json({ status: "success", data: await sweep(), error: null });
      } catch (e) {
        console.log(`ERROR command sweep: ${e?.message}`);
        res.status(503).json({ status: "error", error: { code: 503, message: "sweep failed; the next one continues" }, data: null });
      }
    });
  }

  // Authentication
  // A token that verified is remembered for up to 60 s (common/verified-tokens).
  const validateToken = givenValidateToken ?? cacheVerifications(buildValidateToken({ authUrl }));
  app.use(routes.auth({ validateToken }));

  // Routes
  app.use("/", routes.root());
  app.use("/compile", routes.compile({ taskStorer, compileStorer, dataApi, signingLimiter }));
  // Commands (B5, D1): only with Policy, and allocating only for languages
  // whose COMMANDS_LNNNN is on.
  if (commandWorker) {
    // D2a: a legacy key on /command is served by the legacy compile path.
    const getData = buildRouteGetData({ taskStorer, compileStorer, dataApi });
    const legacy = ({ auth, authToken, id, connectionId, idempotencyKey }) => getData({ auth, authToken, ids: [id], connectionId, idempotencyKey });
    app.use("/command", buildCommandRouter({ taskStorer, policy: commandWorker.policy, run: commandWorker.run, worker: commandWorker.worker, legacy, eligible, materialize: commandWorker.materialize }));
  }
  app.use("/config", routes.configHandler);
  app.use("/data", routes.data({ taskStorer, compileStorer, dataApi, signingLimiter }));
  app.use("/preview", routes.preview({ compile, signingLimiter, interpreter, modelCache }));
  app.use("/lang-overrides", routes.langOverrides({ langOverrideStorer }));
  const langRouter = routes.buildLangRouter({ pingLang, getLangAsset });
  app.use("/lang", langRouter);
  app.use("/L*", langRouter);
  // Browsers go to a language's public URL (its domain); the api's own calls use its base URL.
  app.use("/form", routes.buildFormRouter({ pingLang, getBaseUrlForLanguage: getPublicBaseUrlForLanguage })({ taskStorer }));
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
