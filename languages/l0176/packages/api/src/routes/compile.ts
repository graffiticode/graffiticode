// SPDX-License-Identifier: MIT
import { Router } from "express";
import { buildHttpHandler, parseAuthTokenFromRequest, optionsHandler } from "./utils.js";

type CompileFn = (args: Record<string, any>) => Promise<any>;

const buildPostCompileHandler = ({ compile }: { compile: CompileFn }) =>
  buildHttpHandler(async (req, res) => {
    const auth = (req as any).auth?.context ?? "";
    const authToken = parseAuthTokenFromRequest(req);
    // The body is caller input: it carries the raw token in `auth` (verified
    // above into req.auth.context), so it never overwrites the verified fields.
    const { auth: _bodyAuth, authToken: _bodyAuthToken, identity: _bodyIdentity, ...body } = req.body ?? {};
    // The invocation's identity. The uid comes only from the verified token,
    // which policy re-verifies (userToken). The connection is a caller
    // selection that policy checks. The invocation token and stage come from the gateway; policy verifies the
    // token, so a forged one only gets the compile refused.
    const uid = typeof auth === "object" && typeof (auth as any)?.uid === "string" ? (auth as any).uid : null;
    const identity = {
      uid,
      connectionId: typeof body.connectionId === "string" ? body.connectionId : null,
      userToken: uid ? authToken : null,
      invocationToken: typeof body.invocationToken === "string" ? body.invocationToken : null,
      stage: typeof body.stage === "string" ? body.stage : null,
    };
    try {
      const data = await compile({ ...body, auth, authToken, identity, lang: "0176" });
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
