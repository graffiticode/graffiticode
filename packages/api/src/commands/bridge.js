// The compile-to-command bridge (D2) and what it shares with POST /command
// (C6 plan, decisions 5 and 7; docs/c6-l0176-commands-plan.md §4).
//
//   eligibility(tasks) -> lang | false
//     A chain is command-eligible when some stage is in a language whose
//     COMMANDS_LNNNN is on and performs a write: its preflight manifest's
//     requiredFunctions include a function the registry marks `write`. A chain
//     with no write (a connection preview) is never a command. Answers the
//     first such stage's language.
//
//   BRIDGE_LNNNN (D4): the bridge is on unless set to "off". Off, a compile
//   that reaches that language's write starts nothing: a key that already
//   holds a command is answered from its record, and anything else is refused
//   `bridge-retired`, naming POST /command. Every bridged compile logs one
//   `bridge` line (language, outcome, key kind, user agent), the telemetry D4
//   waits on.
//
//   runCommand({ ... }) -> { protocol: "legacy" | "none" } | { protocol: "command", state, reused }
//     Allocates (or finds) the key's command and runs it when this request
//     owns it, or takes over one whose owner stopped. The same for both routes.
//
//   compileEnvelope({ state, reused }) -> { data?, errors, effects }
//     The command's outcome in today's compile envelope, so a bridged compile
//     answers as a legacy one would.
//
// C5 (docs/c5-l0013-commands-plan.md; COMMAND_SCOPES=on, scopesEnabled):
//   - Eligibility is decided across the whole chain (buildChainEligibility):
//     every stage whose language has a write function is preflighted, and a
//     chain is a command only when every write's language allows commands.
//     A chain with some writes allowed and others not is refused
//     `commands-not-enabled`, never split.
//   - A chain may run with no connection (an L0013 capture, or an L0000 head
//     over one) when no write needs one. One that does (an L0176 save beside
//     a capture) is refused `connection-required` without a connection.
//   - An anonymous compile (no user) runs as an anonymous command through
//     this bridge only, never through POST /command; Policy allows it only as
//     a public capture (decision 4).
//   - A chain in a language whose function writes outside command control
//     (L0013's legacy upload, `writesOutsideCommands`) never falls back to the
//     legacy compile once that language's commands are on: what would have
//     gone there is refused instead.
//   Off, eligibility and every request are exactly what they were.

import { PROTECTED_FUNCTIONS, credentialOf, protectedFunctionsForLang, writesOutsideCommandControl } from "@graffiticode/common/protected-registry";
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
// Whether compiles may still run a language's writes as commands (D4).
export const bridgeEnabled = (lang, env = process.env) => env[`BRIDGE_L${normalizeLang(lang)}`] !== "off";
// Whether this api runs contract v3 commands (C5): COMMAND_SCOPES=on.
export const scopesEnabled = (env = process.env) => env.COMMAND_SCOPES === "on";
// Whether a chain has a stage whose language writes outside command control
// (L0013's legacy upload) and whose commands are on: such a chain never
// falls back to the legacy compile.
export const commandOnlyChain = (tasks, env = process.env) =>
  tasks.some(t => commandsEnabled(t.lang, env) && writesOutsideCommandControl(t.lang));
const hasWriteFunction = lang => Object.values(protectedFunctionsForLang(lang) ?? {}).some(spec => spec.kind === "write");
// What kind of key a bridged compile carried, for the telemetry: the
// console's (save, recompile), the canary's, a generated one (none sent), or
// another client's.
export const keyKindOf = key => (!key ? "generated" : (/^(save|recompile|canary|c6-drive):/.exec(key)?.[1] ?? "other"));

// `preflight`: admission.js's (no effects). A stage that can't be preflighted
// throws (PreflightUnavailable): whether to run a command can't be decided,
// and a new allocation is never guessed.
export const buildEligibility = ({ preflight, baseUrlFor, env = process.env }) => async tasks => {
  for (const [index, task] of tasks.entries()) {
    if (!commandsEnabled(task.lang, env)) continue;
    const out = await preflight({ baseUrl: await baseUrlFor(task.lang), lang: task.lang, stage: `s${index}`, code: task.code });
    const required = out?.manifest?.requiredFunctions ?? [];
    if (required.some(fn => isWriteFunction(task.lang, fn))) return task.lang;
  }
  return false;
};

// C5: the whole chain decides. Every stage in a language with a write
// function is preflighted (a stage that can't be throws PreflightUnavailable,
// as above). Answers false for a chain with no write, or whose writes are all
// in languages without commands (they compile as today); otherwise
//   { lang, writes: [{ stage, lang, fn, credential }], refusal? }
// with `refusal` "commands-not-enabled" when only some writes' languages
// allow commands. `lang` is the first write's language.
export const buildChainEligibility = ({ preflight, baseUrlFor, env = process.env }) => async tasks => {
  const writes = [];
  for (const [index, task] of tasks.entries()) {
    if (!hasWriteFunction(task.lang)) continue;
    const stage = `s${index}`;
    const out = await preflight({ baseUrl: await baseUrlFor(task.lang), lang: task.lang, stage, code: task.code });
    for (const fn of out?.manifest?.requiredFunctions ?? []) {
      if (isWriteFunction(task.lang, fn)) writes.push({ stage, lang: normalizeLang(task.lang), fn, credential: credentialOf(protectedFunctionsForLang(task.lang)[fn]) });
    }
  }
  const enabled = writes.filter(w => commandsEnabled(w.lang, env));
  if (enabled.length === 0) return false;
  const verdict = { lang: enabled[0].lang, writes };
  return enabled.length === writes.length ? verdict : { ...verdict, refusal: "commands-not-enabled" };
};
// Either eligibility's answer, as one shape: null, or { lang, writes, refusal? }
// (`writes` null from the C6 rule, which preflights only flagged languages).
export const eligibilityOf = answer => (!answer ? null : typeof answer === "string" ? { lang: answer, writes: null } : answer);
// Why a chain can't run with no connection, or null: a write that needs one.
export const connectionRequired = verdict => (verdict?.writes ?? []).some(w => w.credential === "connection");

// Allocate, or find, the key's command, and run it if this request owns it or
// its owner stopped. `create: false` (the chain isn't eligible now) only finds
// what a key already holds. Throws PolicyRefused for a refused allocation.
export const runCommand = async ({ policy, run, worker, authToken, connectionId, taskId, inputDigest, idempotencyKey, lang, request, create, anonymous = false, now = Date.now }) => {
  const allocated = await policy.allocate({ authToken, connectionId, taskId, inputDigest, idempotencyKey, lang: normalizeLang(lang), request, worker, create, ...(anonymous ? { anonymous: true } : {}) });
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
  // A refused admission answers as a legacy compile's refusal did, with its
  // reason (C6): nothing ran.
  const refused = record.admissionRefusal?.reason;
  const errors = record.status === "completed"
    ? []
    : refused
      ? [failure(`Error: permission denied (${refused})`, refused)]
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
// `client`: the caller's user agent, for the telemetry only.
// `log`: where the telemetry line goes (stdout, so Cloud Logging).
// C5: with `scopes` (COMMAND_SCOPES=on), `eligible` is buildChainEligibility,
// and a compile with no connection, or no user, may run as a command. A
// compile of a command-only chain (commandOnlyChain) never answers null: a
// refusal answers instead, so it can't reach the legacy compile and its
// direct upload.
export const buildCommandBridge = ({ eligible, getRunner, compileEnvelope, newKey = () => `bridge:${randomUUID()}`, env = process.env, log = line => console.log(line), scopes = scopesEnabled(env) }) =>
  async ({ tasks, id, auth = null, authToken, connectionId = null, options, idempotencyKey, client = null }) => {
    const refusal = (message, code) => ({ errors: [failure(message, code)] });
    const commandOnly = commandOnlyChain(tasks, env);
    // What would otherwise fall back to the legacy compile.
    const noFallback = (message, code) => (commandOnly ? refusal(message, code) : null);
    const runner = getRunner();
    if (!runner) return noFallback("Error: commands are unavailable on this server", "policy-unavailable");
    // Anonymous: no user and no connection (a connection always comes with
    // its user).
    const anonymous = connectionId === null && !auth?.uid;
    let verdict;
    try {
      verdict = eligibilityOf(await eligible(tasks));
    } catch (e) {
      if (!(e instanceof PreflightUnavailable)) throw e;
      return refusal(`Error: ${e.message}`, "preflight-unavailable");
    }
    if (!verdict) return null;
    // A command with no connection runs only on an api that runs v3
    // commands; a command-only chain is refused rather than compiled.
    if (connectionId === null && !scopes) return noFallback("Error: this server can't run a command with no connection", "worker-unsupported");
    const { lang } = verdict;
    const note = async outcome => {
      try {
        log(`bridge ${JSON.stringify({ lang: normalizeLang(lang), outcome, keyKind: keyKindOf(idempotencyKey), client, ...(connectionId === null ? { connection: "none" } : {}), ...(anonymous ? { anonymous: true } : {}) })}`);
      } catch { /* telemetry never fails the compile */ }
    };
    if (verdict.refusal) {
      await note(`refused:${verdict.refusal}`);
      return refusal(`Error: permission denied (${verdict.refusal})`, verdict.refusal);
    }
    if (connectionId === null && connectionRequired(verdict)) {
      await note("refused:connection-required");
      return refusal("Error: this chain writes through a connection; select one", "connection-required");
    }
    // An anonymous caller's key is never its own: every anonymous caller is
    // the same subject, so each anonymous compile gets a fresh key.
    const key = anonymous ? newKey() : (idempotencyKey ?? newKey());
    const run = create => runCommand({
      ...runner,
      authToken: anonymous ? null : authToken,
      connectionId,
      taskId: id,
      inputDigest: inputDigest(options ?? {}),
      idempotencyKey: key,
      lang: tasks[0]?.lang,
      request: JSON.stringify({ id, connectionId, options: options ?? {} }),
      create,
      anonymous,
    });
    if (!bridgeEnabled(lang, env)) {
      // Retired (D4): nothing new starts from a compile. A key that already
      // holds a command is answered from its record.
      if (idempotencyKey && !anonymous) {
        let held;
        try {
          held = await run(false);
        } catch (e) {
          if (!(e instanceof PolicyRefused)) throw e;
          held = null;
        }
        if (held?.protocol === "command") {
          await note("retired-served");
          return compileEnvelope(held);
        }
      }
      await note("retired-refused");
      return { errors: [failure(`Error: saves through POST /compile are retired for L${normalizeLang(lang)}, send them as POST /command`, "bridge-retired")] };
    }
    let ran;
    try {
      ran = await run(true);
    } catch (e) {
      if (!(e instanceof PolicyRefused)) throw e;
      await note(`refused:${e.reason}`);
      return refusal(`Error: permission denied (${e.reason})`, e.reason);
    }
    if (ran.protocol !== "command") {
      // A key the legacy path holds (D2a): compiled as today, except a
      // command-only chain, which is refused.
      if (commandOnly) await note("refused:legacy-protocol");
      return noFallback("Error: this key belongs to a legacy compile; send a new key", "legacy-protocol");
    }
    await note(ran.state?.status ?? "pending");
    return compileEnvelope(ran);
  };
