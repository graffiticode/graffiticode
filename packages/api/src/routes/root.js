import { Router } from "express";

export default () => {
  // @ts-expect-error TS-MIGRATE: express Router is callable; its types reject `new`
  const router = new Router();
  router.get("/", (req, res) => res.sendStatus(200));
  return router;
};
