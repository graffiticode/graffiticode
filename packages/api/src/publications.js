// The gateway's side of publications, which policy holds (see policy
// publications.js). Publishing names the caller's current artifact for a task
// and connection; a view of a published item carries no user, and policy
// answers it with an invocation confined to viewSafe functions.

import { buildPolicyRequest } from "./invocations.js";

const expectData = ({ ok, status, body }, what) => {
  if (!ok || !body?.data) throw new Error(`policy ${what} failed (${status})`);
  return body.data;
};

export const buildPublicationClient = ({ policyUrl, idToken, fetch: doFetch = fetch }) => {
  const request = buildPolicyRequest({ policyUrl, idToken, fetch: doFetch });
  return {
    async create({ authToken, connectionId, taskId, lang, artifactInvocationId }) {
      const res = await request("POST", "/v1/publications", {
        // @ts-expect-error TS-MIGRATE: checkJs infers a destructured parameter's type from its default; optional fields read as missing
        authToken, body: { connectionId, taskId, lang, artifactInvocationId }
      });
      return { publicationId: expectData(res, "publish").publicationId };
    },
    async remove({ authToken, publicationId }) {
      expectData(await request("DELETE", `/v1/publications/${encodeURIComponent(publicationId)}`, { authToken }), "unpublish");
    },
    async authorizeView({ publicationId }) {
      return expectData(await request("POST", `/v1/publications/${encodeURIComponent(publicationId)}/view`), "view");
    }
  };
};
