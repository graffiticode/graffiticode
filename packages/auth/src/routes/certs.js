import { buildHttpHandler } from "@graffiticode/common/http";
import { Router } from "express";

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
  router.post("/", buildRotateKey({ keysService }));
  return router;
};
