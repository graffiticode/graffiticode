// SPDX-License-Identifier: MIT
import { Router } from "express";

export default () => {
  const router = Router();
  router.get("/", (_req, res) => res.sendStatus(200));
  return router;
};
