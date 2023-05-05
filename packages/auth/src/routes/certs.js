import { buildHttpHandler } from "@graffiticode/common/src/http.js";
import { Router } from "express";

const buildGetKeys = ({ keys }) => buildHttpHandler(async (req, res) => {
  const certs = await keys.getPublicCerts();
  res.status(200).json({ keys: certs });
});

const buildRotateKey = ({ keys }) => buildHttpHandler(async (req, res) => {
  await keys.rotateKey();

  res.status(200).json({});
});

export const buildCertsRouter = ({ keys }) => {
  const router = new Router();
  router.get("/", buildGetKeys({ keys }));
  router.post("/", buildRotateKey({ keys }));
  return router;
};
