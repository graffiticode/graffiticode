// SPDX-License-Identifier: MIT
import { Router } from "express";
import { buildHttpHandler, parseAuthTokenFromRequest, optionsHandler } from "./utils.js";

type CompileFn = (args: Record<string, any>) => Promise<any>;

const buildPostCompileHandler = ({ compile }: { compile: CompileFn }) =>
  buildHttpHandler(async (req, res) => {
    const auth = (req as any).auth?.context ?? "";
    const authToken = parseAuthTokenFromRequest(req);
    try {
      const data = await compile({ auth, authToken, lang: "0175", ...req.body });
      res.set("Access-Control-Allow-Origin", "*");
      res.status(200).json(data);
    } catch (error: any) {
      if (error?.message === "Missing required parameters: code and data") {
        res.status(400).json({ error: error.message });
      } else {
        throw error;
      }
    }
  });

export default ({ compile }: { compile: CompileFn }) => {
  const router = Router();
  router.post("/", buildPostCompileHandler({ compile }));
  router.options("/", optionsHandler);
  return router;
};
