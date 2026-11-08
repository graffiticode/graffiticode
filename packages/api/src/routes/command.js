// The public command contract (D1, B5; docs/b5-commands-plan.md §6).
//
//   POST /command { id, connectionId, idempotencyKey, data?, options? }
//     -> { commandId, outcome, result, statusUrl }
//   GET  /command/:id -> the same, for the command's own user
//
// The key is required. A new key allocates a command only while the head
// language's COMMANDS_LNNNN is on; an existing command's key is served from
// its record whatever the flag says now (D2a). A key the legacy compile path
// holds is served by that path (`legacy`, the getData of routes/data.js) and
// answered as a command outcome, with `protocol: "legacy"`; it never becomes a
// command (commands/dispatch.js).

import { randomUUID } from "node:crypto";
import { Router } from "express";
import { buildHttpHandler, parseAuthTokenFromRequest, parseConnectionId, parseIdempotencyKey, setNoStoreCacheHeaders } from "./utils.js";
import { InvalidArgumentError } from "../errors/http.js";
import { buildPostTasks } from "./tasks.js";
import { inputDigest } from "../invocations.js";
import { normalizeLang } from "../admission.js";
import { PolicyRefused } from "../commands/policy-commands.js";
import { legacyOutcome } from "../commands/dispatch.js";

// Whether new commands may be allocated for a language: COMMANDS_LNNNN=on,
// read per request.
export const commandsEnabled = (lang, env = process.env) => env[`COMMANDS_L${normalizeLang(lang)}`] === "on";

// The L0000 task a command's `data` becomes, appended to its chain, exactly as
// POST /compile does (routes/compile.js).
const dataTask = data => ({ lang: "0000", code: { 1: { elts: [JSON.stringify(data)], tag: "STR" }, 2: { elts: [1], tag: "JSON" }, root: 2 } });

const answer = state => ({
  commandId: state.commandId,
  outcome: state.status,
  result: state.result?.state ?? "none",
  statusUrl: `/command/${encodeURIComponent(state.commandId)}`,
});

// `policy`: commands/policy-commands.js. `run`: commands/worker.js's run.
// `worker`: this instance's name in leases.
export const buildCommandRouter = ({ taskStorer, policy, run, worker = `api-${randomUUID()}`, env = process.env, legacy = null }) => {
  // express's Router is callable; its types reject `new`, which works.
  const router = new (/** @type {any} */ (Router))();
  const postTasks = buildPostTasks({ taskStorer });
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
    let id = body.id;
    if (body.data !== undefined) id = [id, await postTasks({ auth, tasks: dataTask(body.data), req })].join("+");
    const tasks = await taskStorer.get({ id, auth });
    const lang = tasks[0]?.lang;

    // A new key needs the flag. A key either protocol already holds is served
    // whatever the flag says now (D2a): with the flag off, Policy only answers
    // which protocol holds the key, and creates nothing.
    const create = commandsEnabled(lang, env);
    let allocated;
    try {
      const options = body.options ?? {};
      allocated = await policy.allocate({
        authToken,
        connectionId,
        taskId: id,
        inputDigest: inputDigest(options),
        idempotencyKey,
        lang: normalizeLang(lang),
        request: JSON.stringify({ id, connectionId, options }),
        worker,
        create,
      });
    } catch (e) {
      if (e instanceof PolicyRefused) return refused(res, e.reason === "idempotency-key-reused" ? 409 : 403, e.reason);
      throw e;
    }
    if (allocated.protocol === "none") return refused(res, 409, "commands-not-enabled");
    if (allocated.protocol === "legacy") {
      if (!legacy) return refused(res, 409, "legacy-protocol");
      const envelope = await legacy({ auth, authToken, id, connectionId, idempotencyKey });
      const outcome = legacyOutcome(envelope);
      res.status(200).json({
        status: "success",
        data: { protocol: "legacy", invocationId: allocated.invocationId, outcome, result: outcome === "completed" && envelope?.data !== undefined ? "available" : "unavailable", ...(envelope?.data !== undefined ? { data: envelope.data } : {}) },
        error: null,
      });
      return;
    }

    let state = allocated;
    if (allocated.owned) {
      state = await run({ commandId: allocated.commandId, generation: allocated.generation });
    } else if (allocated.status === "pending" && allocated.leaseExpiresAt <= Date.now()) {
      // Its owner stopped: take it over and continue it.
      try {
        const taken = await policy.lease({ commandId: allocated.commandId, worker, generation: allocated.generation, takeOver: true });
        state = await run({ commandId: allocated.commandId, generation: taken.generation });
      } catch (e) {
        if (!(e instanceof PolicyRefused)) throw e;
        // Another worker took it first: it is pending under them.
      }
    }
    res.status(200).json({ status: "success", data: answer({ ...allocated, ...state, commandId: allocated.commandId }), error: null });
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
