// The gateway's client for Policy's command routes (B5, docs/b5-commands-plan.md
// §3). Allocation carries the user's token; every other call is the gateway's
// own identity with the command id and the owner's generation, so recovery
// never depends on a user token (decision 3). A refusal with a reason throws
// PolicyRefused; anything else Policy answers that isn't success throws.

import { buildPolicyRequest, PolicyRefused } from "@graffiticode/policy/client";

export { PolicyRefused };

export const buildPolicyCommands = ({ policyUrl, idToken, fetch: doFetch = fetch }) => {
  const request = buildPolicyRequest({ policyUrl, idToken, fetch: doFetch });
  const call = async (method, path, { body = undefined, authToken = null } = {}) => {
    const { ok, status, body: json } = await request(method, path, { body, authToken });
    if (!ok && typeof json?.error?.reason === "string") throw new PolicyRefused(json.error.reason);
    if (!ok || json?.status !== "success") throw new Error(`policy ${method} ${path} failed (${status})`);
    return json.data;
  };
  const at = commandId => `/v1/commands/${encodeURIComponent(commandId)}`;
  return {
    allocate: ({ authToken, connectionId, taskId, inputDigest, idempotencyKey, lang, request: text, worker, create = true }) =>
      call("POST", "/v1/commands", { authToken, body: { connectionId, taskId, inputDigest, idempotencyKey, lang, request: text, worker, create } }),
    get: ({ commandId, authToken = null }) => call("GET", at(commandId), { authToken }),
    due: ({ limit = 20 } = {}) => call("GET", `/v1/commands-due?limit=${limit}`),
    lease: ({ commandId, worker, generation, takeOver = false }) => call("POST", `${at(commandId)}/lease`, { body: { worker, generation, takeOver } }),
    read: ({ commandId, what, stage = null }) => call("GET", `${at(commandId)}/records/${what}${stage ? `?stage=${encodeURIComponent(stage)}` : ""}`),
    installModel: ({ commandId, generation, stage, text, revision = null, tagUrl = null }) =>
      call("PUT", `${at(commandId)}/models/${stage}`, { body: { generation, text, revision, tagUrl } }),
    admit: ({ commandId, generation, taskIds, stages }) => call("POST", `${at(commandId)}/admit`, { body: { generation, taskIds, stages } }),
    session: ({ commandId, generation, stage }) => call("POST", `${at(commandId)}/session`, { body: { generation, stage } }),
    installInput: ({ commandId, generation, stage, text }) => call("PUT", `${at(commandId)}/inputs/${stage}`, { body: { generation, text } }),
    closeStage: ({ commandId, generation, stage, occurrences }) => call("POST", `${at(commandId)}/stages/${stage}/close`, { body: { generation, occurrences } }),
    notReached: ({ commandId, generation, stages }) => call("POST", `${at(commandId)}/not-reached`, { body: { generation, stages } }),
    settle: ({ commandId, generation }) => call("POST", `${at(commandId)}/settle`, { body: { generation } }),
    lost: ({ commandId, generation, stage }) => call("POST", `${at(commandId)}/lost`, { body: { generation, stage } }),
    finish: ({ commandId, generation, result = null }) => call("POST", `${at(commandId)}/finish`, { body: { generation, result } }),
    published: ({ commandId, generation }) => call("POST", `${at(commandId)}/published`, { body: { generation } }),
  };
};
