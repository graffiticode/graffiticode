// The compile-to-command bridge (D2) and what it shares with POST /command
// (C6 plan, decisions 5 and 7; docs/c6-l0176-commands-plan.md §4).
//
//   eligibility(tasks) -> boolean
//     A chain is command-eligible when some stage is in a language whose
//     COMMANDS_LNNNN is on and performs a write: its preflight manifest's
//     requiredFunctions include a function the registry marks `write`. A chain
//     with no write (a connection preview) is never a command.
//
//   runCommand({ ... }) -> { protocol: "legacy" | "none" } | { protocol: "command", state, reused }
//     Allocates (or finds) the key's command and runs it when this request
//     owns it, or takes over one whose owner stopped. The same for both routes.
//
//   compileEnvelope({ state, reused }) -> { data?, errors, effects }
//     The command's outcome in today's compile envelope, so a bridged compile
//     answers as a legacy one would.

import { PROTECTED_FUNCTIONS } from "@graffiticode/common/protected-registry";
import { classify } from "@graffiticode/common/failures";
import { randomUUID } from "node:crypto";
import { normalizeLang, PreflightUnavailable } from "../admission.js";
import { inputDigest } from "../invocations.js";
import { PolicyRefused } from "./policy-commands.js";
import { statusUrlFor } from "./dispatch.js";

// Whether new commands may be allocated for a language: COMMANDS_LNNNN=on,
// read per request.
export const commandsEnabled = (lang, env = process.env) => env[`COMMANDS_L${normalizeLang(lang)}`] === "on";
export const isWriteFunction = (lang, fn) => PROTECTED_FUNCTIONS[normalizeLang(lang)]?.[fn]?.kind === "write";

// `preflight`: admission.js's (no effects). A stage that can't be preflighted
// throws (PreflightUnavailable): whether to run a command can't be decided,
// and a new allocation is never guessed.
export const buildEligibility = ({ preflight, baseUrlFor, env = process.env }) => async tasks => {
  for (const [index, task] of tasks.entries()) {
    if (!commandsEnabled(task.lang, env)) continue;
    const out = await preflight({ baseUrl: await baseUrlFor(task.lang), lang: task.lang, stage: `s${index}`, code: task.code });
    const required = out?.manifest?.requiredFunctions ?? [];
    if (required.some(fn => isWriteFunction(task.lang, fn))) return true;
  }
  return false;
};

// Allocate, or find, the key's command, and run it if this request owns it or
// its owner stopped. `create: false` (the chain isn't eligible now) only finds
// what a key already holds. Throws PolicyRefused for a refused allocation.
export const runCommand = async ({ policy, run, worker, authToken, connectionId, taskId, inputDigest, idempotencyKey, lang, request, create, now = Date.now }) => {
  const allocated = await policy.allocate({ authToken, connectionId, taskId, inputDigest, idempotencyKey, lang: normalizeLang(lang), request, worker, create });
  if (allocated.protocol !== "command") return allocated;
  let state = allocated;
  if (allocated.owned) {
    state = await run({ commandId: allocated.commandId, generation: allocated.generation });
  } else if (allocated.status === "pending" && allocated.leaseExpiresAt <= now()) {
    try {
      const taken = await policy.lease({ commandId: allocated.commandId, worker, generation: allocated.generation, takeOver: true });
      state = await run({ commandId: allocated.commandId, generation: taken.generation });
    } catch (e) {
      // Another worker took it first: it is pending under them.
      if (!(e instanceof PolicyRefused)) throw e;
    }
  }
  return { protocol: "command", state: { ...allocated, ...state, commandId: allocated.commandId }, reused: Boolean(allocated.reused) };
};

const STATUS = { completed: "succeeded", failed: "failed", partial: "partial", uncertain: "uncertain" };
const failure = (message, code) => ({ message, from: -1, to: -1, code, category: classify(code).category });

// Today's compile envelope from a command's records: the head's committed
// result as `data` (only when there is one), an error for any outcome but
// completed, and one effect per write the command settled or was refused, in
// the shape a compile reports (`{ fn, op, status, steps, reason?, replayed?, stage }`).
// A request that found the command already run (`reused`) reports its writes
// as replayed, as a legacy retry's are.
export const buildCompileEnvelope = ({ policy }) => async ({ state, reused }) => {
  const { commandId } = state;
  const read = what => policy.read({ commandId, what });
  const [record, { occurrences }, { outcomes }, { refusals }] = await Promise.all([read("state"), read("occurrences"), read("outcomes"), read("refusals")]);
  const intentOf = (stage, intentId) => record.admission?.stages?.[stage]?.intents?.find(i => i.id === intentId);
  const outcomeOf = new Map(outcomes.map(o => [`${o.stage}:${o.occurrenceId}`, o]));
  const effects = [
    ...occurrences.map(o => {
      const intent = intentOf(o.stage, o.intentId);
      const settled = outcomeOf.get(`${o.stage}:${o.occurrenceId}`);
      return {
        fn: intent?.fn,
        op: intent?.op,
        status: STATUS[settled?.outcome] ?? "uncertain",
        steps: settled?.steps ?? [],
        ...(settled?.reason ? { reason: settled.reason } : {}),
        ...(reused ? { replayed: true } : {}),
        stage: o.stage,
      };
    }),
    ...refusals.map(r => {
      const intent = intentOf(r.stage, r.intentId);
      return { fn: intent?.fn, op: intent?.op, status: "failed", steps: [], reason: r.reason, category: classify(r.reason).category, stage: r.stage };
    }),
  ];
  const statusUrl = statusUrlFor(commandId);
  const errors = record.status === "completed"
    ? []
    : [failure(`Error: the command is ${record.status}, read it at ${statusUrl}`, "command-not-completed")];
  let data;
  if (record.result?.state === "available") {
    const { result } = await read("result");
    data = JSON.parse(result.text);
  }
  return { ...(data !== undefined ? { data } : {}), errors, effects, command: { commandId, outcome: record.status, statusUrl } };
};

// The compile-to-command bridge (D2), for data.js: a compile through a
// connection whose chain is command-eligible runs as a command, with the
// caller's key or a fresh one (today's new invocation per request), and
// answers in the compile envelope. It answers null for any other chain, and
// for a key the legacy path holds (D2a), which then compile as today.
// Refusals answer as a legacy compile's do: errors in the envelope.
// `getRunner()`: the worker's { policy, run, worker }, once built.
export const buildCommandBridge = ({ eligible, getRunner, compileEnvelope, newKey = () => `bridge:${randomUUID()}` }) =>
  async ({ tasks, id, authToken, connectionId, options, idempotencyKey }) => {
    const runner = getRunner();
    if (!runner) return null;
    const refusal = (message, code) => ({ errors: [failure(message, code)] });
    let isEligible;
    try {
      isEligible = await eligible(tasks);
    } catch (e) {
      if (!(e instanceof PreflightUnavailable)) throw e;
      return refusal(`Error: ${e.message}`, "preflight-unavailable");
    }
    if (!isEligible) return null;
    let ran;
    try {
      ran = await runCommand({
        ...runner,
        authToken,
        connectionId,
        taskId: id,
        inputDigest: inputDigest(options ?? {}),
        idempotencyKey: idempotencyKey ?? newKey(),
        lang: tasks[0]?.lang,
        request: JSON.stringify({ id, connectionId, options: options ?? {} }),
        create: true,
      });
    } catch (e) {
      if (!(e instanceof PolicyRefused)) throw e;
      return refusal(`Error: permission denied (${e.reason})`, e.reason);
    }
    if (ran.protocol !== "command") return null;
    return compileEnvelope(ran);
  };
