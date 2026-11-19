/* eslint-disable camelcase */
// The OAuth-store migration contract's HTTP binding, version 1
// (graffiticode-app, packages/core/src/oauth/legacy-contract.ts):
//
//   GET  /oauth-migration/v1/status?installation=<id>        → { contract, fenced, sealed }
//   POST /oauth-migration/v1/consume       { installation, kind, hash, claim_id } → { outcome, reason? }
//   POST /oauth-migration/v1/mark-migrated { installation, hash, mode, claim_id } → { outcome, reason? }
//   POST /oauth-migration/v1/revoke        { installation, hash }                 → { outcome, reason? }
//   GET  /oauth-migration/v1/inventory?installation=<id>&cursor=<c>             → { records, next }
//   POST /oauth-migration/v1/fence         { installation }  (operator)           → { fenced: true }
//   POST /oauth-migration/v1/seal          { installation }  (operator)           → { sealed: true }
//
// Answers are bare JSON, exactly as the contract states them (not the
// { status, data } envelope of auth's other routes). Every route needs the
// internal key; the fence and the seal also need the operator's own key
// (requireMigrationOperatorAuth), which no calling service holds.
import { InvalidArgumentError } from "@graffiticode/common/errors";
import { buildHttpHandler } from "@graffiticode/common/http";
import { Router } from "express";
import { requireInternalAuth, requireMigrationOperatorAuth } from "../middleware/internal-auth.js";

const INSTALLATION = /^[a-z][a-z0-9-]{1,62}$/;
const HASH = /^[0-9a-f]{64}$/;
const KINDS = ["code", "pending"];
const MODES = ["rotation", "import"];

const installationOf = value => {
  if (typeof value !== "string" || !INSTALLATION.test(value)) throw new InvalidArgumentError("must provide installation");
  return value;
};
const hashOf = value => {
  if (typeof value !== "string" || !HASH.test(value)) throw new InvalidArgumentError("must provide hash (64 hex characters)");
  return value;
};
const claimOf = value => {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) throw new InvalidArgumentError("must provide claim_id");
  return value;
};
const oneOf = (value, allowed, name) => {
  if (!allowed.includes(value)) throw new InvalidArgumentError(`${name} must be one of ${allowed.join(", ")}`);
  return value;
};

export const buildOAuthMigrationRouter = ({ oauthMigrationStorer }) => {
  const router = Router();
  router.use(requireInternalAuth);

  router.get("/status", buildHttpHandler(async (req, res) => {
    res.status(200).json(await oauthMigrationStorer.status(installationOf(req.query.installation)));
  }));

  router.post("/consume", buildHttpHandler(async (req, res) => {
    const { installation, kind, hash, claim_id } = req.body ?? {};
    res.status(200).json(await oauthMigrationStorer.consume(installationOf(installation), oneOf(kind, KINDS, "kind"), hashOf(hash), claimOf(claim_id)));
  }));

  router.post("/mark-migrated", buildHttpHandler(async (req, res) => {
    const { installation, hash, mode, claim_id } = req.body ?? {};
    res.status(200).json(await oauthMigrationStorer.markMigrated(installationOf(installation), hashOf(hash), oneOf(mode, MODES, "mode"), claimOf(claim_id)));
  }));

  router.post("/revoke", buildHttpHandler(async (req, res) => {
    const { installation, hash } = req.body ?? {};
    res.status(200).json(await oauthMigrationStorer.revoke(installationOf(installation), hashOf(hash)));
  }));

  router.get("/inventory", buildHttpHandler(async (req, res) => {
    const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : null;
    res.status(200).json(await oauthMigrationStorer.inventory(installationOf(req.query.installation), cursor));
  }));

  router.post("/fence", requireMigrationOperatorAuth, buildHttpHandler(async (req, res) => {
    res.status(200).json(await oauthMigrationStorer.fence(installationOf(req.body?.installation)));
  }));

  router.post("/seal", requireMigrationOperatorAuth, buildHttpHandler(async (req, res) => {
    res.status(200).json(await oauthMigrationStorer.seal(installationOf(req.body?.installation)));
  }));

  return router;
};
