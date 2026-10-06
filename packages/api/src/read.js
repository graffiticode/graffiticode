// The read path for a compile through a connection. A view never runs the
// program: it serves the recipient's current private artifact (see
// storage/artifacts.js), and when the head language signs every render, it
// has that language's compiler sign the stored activity afresh.
//
// Signing sends the compiler a fixed program that holds the unsigned activity
// as a data literal and nothing else, so the only protected operation it can
// reach is the language's implicit preview signature, authorized by policy
// for this view like any compile. L0176's brokered.test.ts compiles this
// exact shape; keep the two in step.

import { REGISTRY_VERSION, compilerConfigForLang } from "@graffiticode/common/protected-registry";
import { InvocationRefused } from "./invocations.js";
import { classify } from "@graffiticode/common/failures";
import { noAudit } from "./audit.js";

export const signProgram = activity => ({
  1: { tag: "STR", elts: [JSON.stringify(activity)] },
  2: { tag: "JSON", elts: [1] },
  3: { tag: "EXPRS", elts: [2] },
  4: { tag: "PROG", elts: [3] },
  root: 4
});

// `code` and `category` say which kind of failure (spec FAIL-01); `message` is
// the text callers already read.
const failure = (message, code) => ({ errors: [{ message, from: -1, to: -1, code, category: classify(code).category }] });

const signsEveryRender = lang => compilerConfigForLang(lang).implicitProtectedFunctions.length > 0;

// Signs a stored result for a view, when the head language signs every
// render; otherwise serves it as stored.
const signStored = async ({ compile, lang, content, connectionId, invocationToken, stage, uid, authToken }) => {
  if (!signsEveryRender(lang) || !content?.data || typeof content.data !== "object") {
    return content;
  }
  const signed = await compile({
    lang,
    code: signProgram(content.data),
    data: {},
    auth: authToken,
    options: {},
    uid,
    connectionId,
    invocationToken,
    stage
  });
  const { cache: _cache, ...envelope } = signed ?? {};
  return envelope;
};

export const buildReadArtifact = ({ compile, artifactStorer, allocateInvocation, audit = noAudit }) =>
  async ({ tasks, id, uid, authToken, connectionId }) => {
    if (!artifactStorer || !allocateInvocation) {
      return failure("Error: connections are not available on this server.", "connections-unavailable");
    }
    const current = await artifactStorer.getCurrent({ uid, taskId: id, connectionId, registryVersion: REGISTRY_VERSION });
    if (current.status === "missing") {
      return failure("Error: this version has no result through this connection yet. Save or recompile the item to create one.", "artifact-not-found");
    }
    if (current.status === "incompatible") {
      return failure("Error: this item's result was made by an older version. Recompile the item to update it.", "artifact-incompatible");
    }
    const { content, invocationId } = current.artifact;
    const [head] = tasks;
    if (!signsEveryRender(head.lang)) {
      return content;
    }
    // One invocation per artifact for all of its views: the key names the
    // artifact, so repeated views reuse it rather than allocating each time.
    let invocation;
    try {
      invocation = await allocateInvocation({
        authToken, connectionId, taskId: id, options: {}, idempotencyKey: `read.${invocationId}`
      });
    } catch (e) {
      if (e instanceof InvocationRefused) {
        await audit({ event: "gateway-invocation", outcome: "denied", reason: e.reason, category: classify(e.reason).category, connectionId });
        return failure(`Error: permission denied (${e.reason})`, e.reason);
      }
      await audit({ event: "gateway-invocation", outcome: "failed", reason: "policy-unavailable", category: "unavailable", connectionId });
      return failure("Error: could not authorize this view", "policy-unavailable");
    }
    return signStored({
      compile, lang: head.lang, content, connectionId, invocationToken: invocation.invocationToken, stage: "read", uid, authToken
    });
  };

// A view of a published item. It runs under the publication, never the
// viewer: policy re-checks the publication live and answers with an
// invocation confined to viewSafe functions, and the compiler is sent no user.
// The artifact is the one the publication names, never the viewer's own.
export const buildReadPublished = ({ compile, artifactStorer, publications, audit = noAudit }) =>
  async ({ tasks, id, publicationId }) => {
    if (!artifactStorer || !publications) {
      return failure("Error: publications are not available on this server.", "publications-unavailable");
    }
    let view;
    try {
      view = await publications.authorizeView({ publicationId });
    } catch (e) {
      // The audit names no publication: the id is the viewer's, unverified.
      if (e instanceof InvocationRefused) {
        await audit({ event: "publication-read", outcome: "denied", reason: e.reason, category: classify(e.reason).category });
        return failure(`Error: this item is not published (${e.reason})`, e.reason);
      }
      await audit({ event: "publication-read", outcome: "failed", reason: "policy-unavailable", category: "unavailable" });
      return failure("Error: could not authorize this view", "policy-unavailable");
    }
    const [head] = tasks;
    if (view.taskId !== id || view.lang !== head.lang) {
      return failure("Error: this publication is for another item.", "publication-other-item");
    }
    const artifact = await artifactStorer.getByInvocation(view.artifactInvocationId);
    if (!artifact || artifact.uid !== view.publisherUid || artifact.connectionId !== view.connectionId ||
        artifact.taskId !== id) {
      return failure("Error: the published result is no longer available. The publisher can run it and publish again.", "published-artifact-unavailable");
    }
    if (artifact.registryVersion !== REGISTRY_VERSION) {
      return failure("Error: the published result was made by an older version. The publisher can run it and publish again.", "artifact-incompatible");
    }
    // Verified by Policy (authorizeView), so the publication can be named.
    await audit({ event: "publication-read", outcome: "allowed", publicationId, connectionId: view.connectionId });
    return signStored({
      compile,
      lang: head.lang,
      content: artifact.content,
      connectionId: view.connectionId,
      invocationToken: view.invocationToken,
      stage: "view",
      uid: null,
      authToken: null
    });
  };
