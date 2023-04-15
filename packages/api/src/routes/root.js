import { Router } from "express";

export default () => {
  const router = new Router();
  router.get("/", (req, res) => res.sendStatus(200));
  return router;
};
