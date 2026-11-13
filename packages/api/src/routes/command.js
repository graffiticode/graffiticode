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
//
// Repairs (B6, docs/b6-command-repair-plan.md decisions 3, 9, 10), for the
// command's own user, while REPAIR_LNNNN is on for its language (off, both
// answer `repair-unavailable`):
//   POST /command/:id/repair { idempotencyKey, occurrences? }
//     -> { commandId, outcome, result, statusUrl, repairOf }   a repair, run now
//   POST /command/:id/materialize
//     -> { commandId, outcome, result: "available", published, statusUrl }
//     the command rebuilt from its records and stored as its artifact

import { randomUUID } from "node:crypto";
import { Router } from "express";
import { buildHttpHandler, parseAuthTokenFromRequest, parseConnectionId, parseIdempotencyKey, setNoStoreCacheHeaders } from "./utils.js";
import { InvalidArgumentError } from "../errors/http.js";
import { buildPostTasks } from "./tasks.js";
import { buildChainWithData } from "./chain.js";
import { inputDigest } from "../invocations.js";
import { classify } from "@graffiticode/common/failures";
import { PolicyRefused } from "../commands/policy-commands.js";
import { normalizeLang } from "../admission.js";
import { legacyOutcome } from "../commands/dispatch.js";
import { commandsEnabled, runCommand } from "../commands/bridge.js";

export { commandsEnabled };

// Whether repairs and materialization are on for a language (decision 10).
export const repairEnabled = (lang, env = process.env) => env[`REPAIR_L${normalizeLang(lang)}`] === "on";
// For a command: on for the language of every stage with effects, as its
// admission recorded them, whatever language its head is (an L0176 save under
// an L0000 head is L0176's to repair; the owner's review of #387). A command
// with no stage with effects has nothing to repair.
export const repairEnabledFor = (admission, env = process.env) => {
  const langs = [...new Set(Object.values(admission?.stages ?? {}).filter(s => (s?.intents ?? []).length > 0).map(s => s.lang))];
  return langs.length > 0 && langs.every(lang => repairEnabled(lang, env));
};
// A refusal's HTTP status, from its category.
const STATUS_OF = { authentication: 401, permission: 403, malformed: 400, conflict: 409, unavailable: 503 };

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
// `materialize({ commandId })`: commands/records.js's materializeCommand, bound
// to this api's interpreter and artifact store.
export const buildCommandRouter = ({ taskStorer, policy, run, worker = `api-${randomUUID()}`, env = process.env, legacy = null, eligible = null, materialize = null, now = Date.now }) => {
  // express's Router is callable; its types reject `new`, which works.
  const router = new (/** @type {any} */ (Router))();
  const postTasks = buildPostTasks({ taskStorer });
  const withData = buildChainWithData({ postTasks });
  const isEligible = eligible ?? (async tasks => tasks.some(t => commandsEnabled(t.lang, env)));
  const refused = (res, status, reason, detail = null) => res.status(status).json({ status: "error", error: { code: status, message: "command refused", reason, ...(detail ? { detail } : {}) }, data: null });

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
    const create = Boolean(await isEligible(tasks));
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

  // The command, for its own user (their token reads it), with repairs on for
  // its language; or why not, already answered.
  const repairable = async (req, res) => {
    setNoStoreCacheHeaders(res);
    if (!req.auth?.context?.uid) return refused(res, 401, "no-user") && null;
    const authToken = parseAuthTokenFromRequest(req);
    let command;
    try {
      command = await policy.get({ commandId: req.params.id, authToken });
    } catch (e) {
      if (e instanceof PolicyRefused) return refused(res, 404, e.reason) && null;
      throw e;
    }
    // The command is the user's (their token read it); its admission, the
    // gateway's read, says which languages act.
    const { admission } = await policy.read({ commandId: req.params.id, what: "state" });
    if (!repairEnabledFor(admission, env)) return refused(res, 409, "repair-unavailable") && null;
    return { command, authToken };
  };

  router.post("/:id/repair", buildHttpHandler(async (req, res) => {
    const found = await repairable(req, res);
    if (!found) return;
    const body = req.body ?? {};
    const idempotencyKey = parseIdempotencyKey(req.get("Idempotency-Key") ?? body.idempotencyKey, { connectionId: found.command.connectionId });
    if (!idempotencyKey) throw new InvalidArgumentError("a repair needs an idempotency key");
    const occurrences = body.occurrences ?? null;
    let state;
    try {
      const allocated = await policy.allocateRepair({ authToken: found.authToken, commandId: req.params.id, idempotencyKey, occurrences, worker });
      state = allocated;
      // As a command's request: run it now when this worker owns it, or take
      // over one whose worker stopped.
      if (allocated.owned) {
        state = { ...allocated, ...(await run({ commandId: allocated.commandId, generation: allocated.generation })) };
      } else if (allocated.status === "pending" && allocated.leaseExpiresAt <= now()) {
        try {
          const taken = await policy.lease({ commandId: allocated.commandId, worker, generation: allocated.generation, takeOver: true });
          state = { ...allocated, ...(await run({ commandId: allocated.commandId, generation: taken.generation })) };
        } catch (e) {
          if (!(e instanceof PolicyRefused)) throw e;
        }
      }
      state = { ...state, commandId: allocated.commandId };
    } catch (e) {
      if (e instanceof PolicyRefused) return refused(res, e.reason === "command-not-found" ? 404 : STATUS_OF[classify(e.reason).category] ?? 403, e.reason, e.detail ?? null);
      throw e;
    }
    res.status(200).json({ status: "success", data: { ...answer(state), repairOf: req.params.id }, error: null });
  }));

  router.post("/:id/materialize", buildHttpHandler(async (req, res) => {
    const found = await repairable(req, res);
    if (!found) return;
    if (!materialize) return refused(res, 409, "repair-unavailable");
    const out = await materialize({ commandId: req.params.id });
    if (!out.ok) {
      const { reason, ok: _ok, ...detail } = out;
      return refused(res, STATUS_OF[classify(reason).category] ?? 409, reason, Object.keys(detail).length ? detail : null);
    }
    res.status(200).json({ status: "success", data: { ...answer(found.command), result: "available", published: out.published }, error: null });
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
