import { Router } from "express";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import { HttpError, InvalidArgumentError, UnauthenticatedError } from "../errors/http.js";
import { InvocationRefused } from "../invocations.js";
import {
  buildHttpHandler,
  createSuccessResponse,
  parseAuthTokenFromRequest,
  parseConnectionId,
  parsePublicationId,
  optionsHandler
} from "./utils.js";

//   POST   /publications        { id, connectionId }  publish the caller's current result for a task
//                                                     -> { publicationId }
//   DELETE /publications/:pubId                       unpublish
//
// Publishing names the caller's CURRENT artifact for that task and connection:
// never another recipient's, and never one that is missing or from another
// registry version. Policy checks the authority and holds the record. Views go
// through GET /data?id=<task>&publication=<publicationId>.

const refusal = e => new HttpError({ code: 403, message: `permission denied (${e.reason})`, reason: e.reason });
const unavailable = () => new HttpError({ code: 501, message: "publications are not available on this server" });

export default ({ taskStorer, artifactStorer, publications }) => {
  // @ts-expect-error TS-MIGRATE: express Router is callable; its types reject `new`
  const router = new Router();
  router.post("/", buildHttpHandler(async (req, res) => {
    const auth = req.auth.context;
    if (!auth?.uid) throw new UnauthenticatedError("publishing requires a signed-in caller");
    if (!publications || !artifactStorer) throw unavailable();
    const authToken = parseAuthTokenFromRequest(req);
    const id = req.body?.id;
    if (typeof id !== "string" || !id) throw new InvalidArgumentError("id is required");
    const connectionId = parseConnectionId(req.body?.connectionId, { auth });
    if (!connectionId) throw new InvalidArgumentError("connectionId is required");
    const tasks = await taskStorer.get({ id, auth });
    if (!tasks) throw new InvalidArgumentError("task not found");
    const current = await artifactStorer.getCurrent({ uid: auth.uid, taskId: id, connectionId, registryVersion: REGISTRY_VERSION });
    if (current.status !== "ok") {
      throw new HttpError({ code: 409, message: "run this item through the connection before publishing it" });
    }
    try {
      const { publicationId } = await publications.create({
        authToken, connectionId, taskId: id, lang: tasks[0].lang, artifactInvocationId: current.artifact.invocationId
      });
      res.status(200).json(createSuccessResponse({ data: { publicationId } }));
    } catch (e) {
      if (e instanceof InvocationRefused) throw refusal(e);
      throw e;
    }
  }));
  router.delete("/:publicationId", buildHttpHandler(async (req, res) => {
    const auth = req.auth.context;
    if (!auth?.uid) throw new UnauthenticatedError("unpublishing requires a signed-in caller");
    if (!publications) throw unavailable();
    const publicationId = parsePublicationId(req.params.publicationId);
    try {
      await publications.remove({ authToken: parseAuthTokenFromRequest(req), publicationId });
      res.status(200).json(createSuccessResponse({ data: { publicationId, deleted: true } }));
    } catch (e) {
      if (e instanceof InvocationRefused) throw refusal(e);
      throw e;
    }
  }));
  router.options("/", optionsHandler);
  return router;
};
