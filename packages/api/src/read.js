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

export const signProgram = activity => ({
  1: { tag: "STR", elts: [JSON.stringify(activity)] },
  2: { tag: "JSON", elts: [1] },
  3: { tag: "EXPRS", elts: [2] },
  4: { tag: "PROG", elts: [3] },
  root: 4
});

const failure = message => ({ errors: [{ message, from: -1, to: -1 }] });

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

export const buildReadArtifact = ({ compile, artifactStorer, allocateInvocation }) =>
  async ({ tasks, id, uid, authToken, connectionId }) => {
    if (!artifactStorer || !allocateInvocation) {
      return failure("Error: connections are not available on this server.");
    }
    const current = await artifactStorer.getCurrent({ uid, taskId: id, connectionId, registryVersion: REGISTRY_VERSION });
    if (current.status === "missing") {
      return failure("Error: this version has no result through this connection yet. Save or recompile the item to create one.");
    }
    if (current.status === "incompatible") {
      return failure("Error: this item's result was made by an older version. Recompile the item to update it.");
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
      return failure(e instanceof InvocationRefused
        ? `Error: permission denied (${e.reason})`
        : "Error: could not authorize this view");
    }
    return signStored({
      compile, lang: head.lang, content, connectionId, invocationToken: invocation.invocationToken, stage: "read", uid, authToken
    });
  };

// A view of a published item. It runs under the publication, never the
// viewer: policy re-checks the publication live and answers with an
// invocation confined to viewSafe functions, and the compiler is sent no user.
// The artifact is the one the publication names, never the viewer's own.
export const buildReadPublished = ({ compile, artifactStorer, publications }) =>
  async ({ tasks, id, publicationId }) => {
    if (!artifactStorer || !publications) {
      return failure("Error: publications are not available on this server.");
    }
    let view;
    try {
      view = await publications.authorizeView({ publicationId });
    } catch (e) {
      return failure(e instanceof InvocationRefused
        ? `Error: this item is not published (${e.reason})`
        : "Error: could not authorize this view");
    }
    const [head] = tasks;
    if (view.taskId !== id || view.lang !== head.lang) {
      return failure("Error: this publication is for another item.");
    }
    const artifact = await artifactStorer.getByInvocation(view.artifactInvocationId);
    if (!artifact || artifact.uid !== view.publisherUid || artifact.connectionId !== view.connectionId ||
        artifact.taskId !== id) {
      return failure("Error: the published result is no longer available. The publisher can run it and publish again.");
    }
    if (artifact.registryVersion !== REGISTRY_VERSION) {
      return failure("Error: the published result was made by an older version. The publisher can run it and publish again.");
    }
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
