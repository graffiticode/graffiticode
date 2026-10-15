// SPDX-License-Identifier: MIT
import { Router } from "express";
import type { Request } from "express";
import { buildHttpHandler, parseAuthTokenFromRequest, optionsHandler } from "./utils.js";

type CompileFn = (args: Record<string, any>) => Promise<any>;
type VerifyGateway = (headers: Record<string, unknown>) => Promise<unknown>;

// Gateway-only (plan system-preview-rate-limit): a compile with no connection
// is signed on the system path only when its `X-Caller-Identity` verifies as
// the api's (a PREFLIGHT_GATEWAYS account, audience urn:graffiticode:0176, the
// verifier /preflight uses), or the server runs with SYSTEM_PREVIEW_DIRECT=1.
// A missing, forged, expired or wrong-audience token, or a verifier that
// can't run, is just "not verified": the compile still runs and its preview
// comes back unsigned, `gateway-only`. Nothing in the body counts.
const systemPreviewPermitted = async (req: Request, verifyGateway: VerifyGateway | undefined, direct: boolean) => {
  if (direct) return true;
  if (!verifyGateway) return false;
  try {
    await verifyGateway(req.headers as Record<string, unknown>);
    return true;
  } catch {
    return false;
  }
};

const buildPostCompileHandler = ({
  compile,
  verifyGateway,
  systemPreviewDirect = false,
}: {
  compile: CompileFn;
  verifyGateway?: VerifyGateway;
  systemPreviewDirect?: boolean;
}) =>
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
    const connectionId = typeof body.connectionId === "string" ? body.connectionId : null;
    const identity = {
      uid,
      connectionId,
      userToken: uid ? authToken : null,
      invocationToken: typeof body.invocationToken === "string" ? body.invocationToken : null,
      stage: typeof body.stage === "string" ? body.stage : null,
      // The admitted plan (capability plan W4), from the gateway; policy verifies it.
      admissionToken: typeof body.admissionToken === "string" ? body.admissionToken : null,
      // Whether a no-connection preview may be signed on the system path: from
      // the verified caller identity (or SYSTEM_PREVIEW_DIRECT=1) alone. A
      // connection compile never uses it, so it isn't checked for one.
      systemPreview: connectionId ? false : await systemPreviewPermitted(req, verifyGateway, systemPreviewDirect),
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

export default ({
  compile,
  verifyGateway,
  systemPreviewDirect,
}: {
  compile: CompileFn;
  verifyGateway?: VerifyGateway;
  systemPreviewDirect?: boolean;
}) => {
  const router = Router();
  router.post("/", buildPostCompileHandler({ compile, verifyGateway, systemPreviewDirect }));
  router.options("/", optionsHandler);
  return router;
};
