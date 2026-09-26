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

export const buildReadArtifact = ({ compile, artifactStorer, allocateInvocation }) =>
  async ({ tasks, id, uid, authToken, connectionId }) => {
    if (!artifactStorer || !allocateInvocation) {
      return failure("Error: connections are not available on this server.");
    }
    const current = await artifactStorer.getCurrent({ uid, taskId: id, connectionId, registryVersion: REGISTRY_VERSION });
    if (current.status === "missing") {
      return failure("Error: this item has not been run through this connection. Run it to create a result.");
    }
    if (current.status === "incompatible") {
      return failure("Error: this item's result was made by an older version. Run it again to update it.");
    }
    const { content, invocationId } = current.artifact;
    const [head] = tasks;
    if (!signsEveryRender(head.lang) || !content?.data || typeof content.data !== "object") {
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
    const signed = await compile({
      lang: head.lang,
      code: signProgram(content.data),
      data: {},
      auth: authToken,
      options: {},
      uid,
      connectionId,
      invocationToken: invocation.invocationToken,
      stage: "read"
    });
    const { cache: _cache, ...envelope } = signed ?? {};
    return envelope;
  };
