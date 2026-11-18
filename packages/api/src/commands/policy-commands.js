// The gateway's client for Policy's command routes (B5, docs/b5-commands-plan.md
// §3). Allocation carries the user's token; every other call is the gateway's
// own identity with the command id and the owner's generation, so recovery
// never depends on a user token (decision 3). A refusal with a reason throws
// PolicyRefused; anything else Policy answers that isn't success throws.
// A refusal Policy marks `retryable` (C5: it can't decide now, or another
// worker can) throws PolicyUnavailable, which isn't a PolicyRefused: the
// worker leaves the command pending for recovery instead of failing it.
//
// `scopes` (C5, COMMAND_SCOPES=on): this api runs contract v3 commands, those
// with item scopes or no connection, and declares it on every call that
// decides who may own a command: allocation, admission, lease (renewal and
// takeover) and the due query. Policy hands a v3 command only to a worker
// that declares it. Off, no request carries it, so each is exactly what it
// was before C5.

import { buildPolicyRequest, PolicyRefused } from "@graffiticode/policy/client";

export { PolicyRefused };

export class PolicyUnavailable extends Error {
  constructor(reason) {
    super(`policy can't decide now (${reason})`);
    this.name = "PolicyUnavailable";
    this.reason = reason;
  }
}

export const buildPolicyCommands = ({ policyUrl, idToken, fetch: doFetch = fetch, scopes = false }) => {
  const request = buildPolicyRequest({ policyUrl, idToken, fetch: doFetch });
  const call = async (method, path, { body = undefined, authToken = null } = {}) => {
    const { ok, status, body: json } = await request(method, path, { body, authToken });
    if (!ok && json?.error?.retryable === true && typeof json.error.reason === "string") throw new PolicyUnavailable(json.error.reason);
    if (!ok && typeof json?.error?.reason === "string") throw new PolicyRefused(json.error.reason, json.error.detail ?? null);
    if (!ok || json?.status !== "success") throw new Error(`policy ${method} ${path} failed (${status})`);
    return json.data;
  };
  const at = commandId => `/v1/commands/${encodeURIComponent(commandId)}`;
  // The one capability statement, on every call that decides ownership.
  const declared = scopes ? { scopes: 1 } : {};
  return {
    // Whether this client declares `scopes`: the bridge and POST /command run
    // connectionless chains only when it does.
    scopes: scopes === true,
    // `anonymous` (C5 decision 4, the bridge only): no user token and no
    // connection; Policy's subject is then `anonymous`.
    allocate: ({ authToken, connectionId, taskId, inputDigest, idempotencyKey, lang, request: text, worker, create = true, anonymous = false }) =>
      call("POST", "/v1/commands", { authToken: anonymous ? null : authToken, body: { connectionId, taskId, inputDigest, idempotencyKey, lang, request: text, worker, create, ...(anonymous ? { anonymous: true } : {}), ...declared } }),
    get: ({ commandId, authToken = null }) => call("GET", at(commandId), { authToken }),
    // A repair of a command (B6 slice 4), with the user's token, as allocation.
    allocateRepair: ({ authToken, commandId, idempotencyKey, occurrences = null, worker }) =>
      call("POST", `${at(commandId)}/repairs`, { authToken, body: { idempotencyKey, occurrences, worker } }),
    // This worker records stage outputs (B6, decision 5) and runs repairs
    // (slice 4), and says so on every lease and sweep: Policy gives a
    // recording command, or a repair, only to a worker that does, and lists it
    // as due only to one.
    due: ({ limit = 20 } = {}) => call("GET", `/v1/commands-due?limit=${limit}&recording=1&repairs=1${scopes ? "&scopes=1" : ""}`),
    lease: ({ commandId, worker, generation, takeOver = false }) => call("POST", `${at(commandId)}/lease`, { body: { worker, generation, takeOver, recording: 1, repairs: 1, ...declared } }),
    read: ({ commandId, what, stage = null }) => call("GET", `${at(commandId)}/records/${what}${stage ? `?stage=${encodeURIComponent(stage)}` : ""}`),
    installModel: ({ commandId, generation, stage, text, revision = null, tagUrl = null }) =>
      call("PUT", `${at(commandId)}/models/${stage}`, { body: { generation, text, revision, tagUrl } }),
    admit: ({ commandId, generation, taskIds, stages, recording = 0 }) => call("POST", `${at(commandId)}/admit`, { body: { generation, taskIds, stages, recording, ...declared } }),
    session: ({ commandId, generation, stage }) => call("POST", `${at(commandId)}/session`, { body: { generation, stage } }),
    installInput: ({ commandId, generation, stage, text }) => call("PUT", `${at(commandId)}/inputs/${stage}`, { body: { generation, text } }),
    installOutput: ({ commandId, generation, stage, text }) => call("PUT", `${at(commandId)}/outputs/${stage}`, { body: { generation, text } }),
    closeStage: ({ commandId, generation, stage, occurrences }) => call("POST", `${at(commandId)}/stages/${stage}/close`, { body: { generation, occurrences } }),
    notReached: ({ commandId, generation, stages }) => call("POST", `${at(commandId)}/not-reached`, { body: { generation, stages } }),
    settle: ({ commandId, generation }) => call("POST", `${at(commandId)}/settle`, { body: { generation } }),
    lost: ({ commandId, generation, stage }) => call("POST", `${at(commandId)}/lost`, { body: { generation, stage } }),
    finish: ({ commandId, generation, result = null }) => call("POST", `${at(commandId)}/finish`, { body: { generation, result } }),
    published: ({ commandId, generation }) => call("POST", `${at(commandId)}/published`, { body: { generation } }),
  };
};
