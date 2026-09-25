import { buildHttpHandler } from "@graffiticode/common/http";
import { Router } from "express";
import { requireInternalAuth } from "../middleware/internal-auth.js";

const buildGetKeys = ({ keysService }) => buildHttpHandler(async (req, res) => {
  const certs = await keysService.getPublicCerts();
  res.status(200).json({ keys: certs });
});

const buildRotateKey = ({ keysService }) => buildHttpHandler(async (req, res) => {
  await keysService.rotateKey();

  res.status(200).json({});
});

export const buildCertsRouter = ({ keysService }) => {
  const router = new Router();
  router.get("/", buildGetKeys({ keysService }));
  // Rotation switches the signing key and appends to the published JWKS, so it
  // is an internal operation: unauthenticated, anyone could churn the key and
  // grow `keys` without bound.
  router.post("/", requireInternalAuth, buildRotateKey({ keysService }));
  return router;
};
