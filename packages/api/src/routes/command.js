// The public command contract (D1, B5; docs/b5-commands-plan.md §6).
//
//   POST /command { id, connectionId, idempotencyKey, data?, options? }
//     -> { commandId, outcome, result, statusUrl }
//   GET  /command/:id -> the same, for the command's own user
//
// The key is required. A new key allocates a command only when the chain is
// command-eligible (C6, decision 7: a stage whose COMMANDS_LNNNN is on and
// that writes; commands/bridge.js), the same rule the compile bridge uses; a
// chain with no write is refused `no-effects`. An existing command's key is
// served from its record whatever the flags say now (D2a). The chain is built
// from `id` and `data` exactly as POST /compile builds it (routes/chain.js). A key the legacy compile path
// holds is served by that path (`legacy`, the getData of routes/data.js) and
// answered as a command outcome, with `protocol: "legacy"`; it never becomes a
// command (commands/dispatch.js).

import { randomUUID } from "node:crypto";
import { Router } from "express";
import { buildHttpHandler, parseAuthTokenFromRequest, parseConnectionId, parseIdempotencyKey, setNoStoreCacheHeaders } from "./utils.js";
import { InvalidArgumentError } from "../errors/http.js";
import { buildPostTasks } from "./tasks.js";
import { buildChainWithData } from "./chain.js";
import { inputDigest } from "../invocations.js";
import { PolicyRefused } from "../commands/policy-commands.js";
import { legacyOutcome } from "../commands/dispatch.js";
import { commandsEnabled, runCommand } from "../commands/bridge.js";

export { commandsEnabled };

// `reason`: why Policy refused the command's admission, when it did (a
// permission not granted, a revision retired, ...); the command failed with
// nothing run.
const answer = state => ({
  commandId: state.commandId,
  outcome: state.status,
  result: state.result?.state ?? "none",
  statusUrl: `/command/${encodeURIComponent(state.commandId)}`,
  ...(state.admissionRefusal?.reason ? { reason: state.admissionRefusal.reason } : {}),
});

// `policy`: commands/policy-commands.js. `run`: commands/worker.js's run.
// `worker`: this instance's name in leases.
// `eligible(tasks)`: commands/bridge.js's buildEligibility. Without one (tests
// that predate it), the chain is eligible when any stage's flag is on.
export const buildCommandRouter = ({ taskStorer, policy, run, worker = `api-${randomUUID()}`, env = process.env, legacy = null, eligible = null }) => {
  // express's Router is callable; its types reject `new`, which works.
  const router = new (/** @type {any} */ (Router))();
  const postTasks = buildPostTasks({ taskStorer });
  const withData = buildChainWithData({ postTasks });
  const isEligible = eligible ?? (async tasks => tasks.some(t => commandsEnabled(t.lang, env)));
  const refused = (res, status, reason) => res.status(status).json({ status: "error", error: { code: status, message: "command refused", reason }, data: null });

  router.post("/", buildHttpHandler(async (req, res) => {
    setNoStoreCacheHeaders(res);
    const auth = req.auth?.context;
    if (!auth?.uid) return refused(res, 401, "no-user");
    const authToken = parseAuthTokenFromRequest(req);
    const body = req.body ?? {};
    const connectionId = parseConnectionId(body.connectionId, { auth });
    if (!connectionId) throw new InvalidArgumentError("a command needs a connection");
    const idempotencyKey = parseIdempotencyKey(req.get("Idempotency-Key") ?? body.idempotencyKey, { connectionId });
    if (!idempotencyKey) throw new InvalidArgumentError("a command needs an idempotency key");
    if (typeof body.id !== "string" || !body.id) throw new InvalidArgumentError("a command needs the id of the task chain it runs");
    const { id } = await withData({ auth, id: body.id, data: body.data, req });
    const tasks = await taskStorer.get({ id, auth });
    const lang = tasks[0]?.lang;

    // A new key needs an eligible chain. A key either protocol already holds
    // is served whatever the flags say now (D2a): otherwise Policy only answers
    // which protocol holds the key, and creates nothing.
    const create = await isEligible(tasks);
    let outcome;
    try {
      outcome = await runCommand({
        policy,
        run,
        worker,
        authToken,
        connectionId,
        taskId: id,
        inputDigest: inputDigest(body.options ?? {}),
        idempotencyKey,
        lang,
        request: JSON.stringify({ id, connectionId, options: body.options ?? {} }),
        create,
      });
    } catch (e) {
      if (e instanceof PolicyRefused) return refused(res, e.reason === "idempotency-key-reused" ? 409 : 403, e.reason);
      throw e;
    }
    const allocated = outcome;
    if (allocated.protocol === "none") {
      // A chain with a flagged stage but no write is a read: nothing to command.
      const flagged = tasks.some(t => commandsEnabled(t.lang, env));
      return refused(res, 409, flagged ? "no-effects" : "commands-not-enabled");
    }
    if (allocated.protocol === "legacy") {
      if (!legacy) return refused(res, 409, "legacy-protocol");
      const envelope = await legacy({ auth, authToken, id, connectionId, idempotencyKey });
      const served = legacyOutcome(envelope);
      res.status(200).json({
        status: "success",
        data: { protocol: "legacy", invocationId: allocated.invocationId, outcome: served, result: served === "completed" && envelope?.data !== undefined ? "available" : "unavailable", ...(envelope?.data !== undefined ? { data: envelope.data } : {}) },
        error: null,
      });
      return;
    }

    res.status(200).json({ status: "success", data: answer(outcome.state), error: null });
  }));

  router.get("/:id", buildHttpHandler(async (req, res) => {
    setNoStoreCacheHeaders(res);
    if (!req.auth?.context?.uid) return refused(res, 401, "no-user");
    try {
      const state = await policy.get({ commandId: req.params.id, authToken: parseAuthTokenFromRequest(req) });
      res.status(200).json({ status: "success", data: answer(state), error: null });
    } catch (e) {
      if (e instanceof PolicyRefused) return refused(res, 404, e.reason);
      throw e;
    }
  }));
  return router;
};
