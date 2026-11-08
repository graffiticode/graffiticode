// D2a across the two paths (B5 slice 7, docs/b5-commands-plan.md §8): a key's
// protocol is the one its first allocation recorded, and it decides how every
// later request with that key is served, whichever route it comes in by.
//
//   - A command's key on POST /compile (Policy refuses the legacy allocation
//     with command-protocol) is answered from the command's record: its result
//     when it completed with one, and otherwise its outcome and status URL. It
//     is never compiled.
//   - A legacy key on POST /command is served by the legacy compile path, at
//     its admitted plan, and answered as a command outcome. It never becomes a
//     command.

import { createHash } from "node:crypto";
import { classify } from "@graffiticode/common/failures";
import { PolicyRefused } from "./policy-commands.js";

export const commandIdFor = (uid, idempotencyKey) => `c:${createHash("sha256").update(JSON.stringify([uid, idempotencyKey])).digest("hex")}`;
export const statusUrlFor = commandId => `/command/${encodeURIComponent(commandId)}`;
const failure = (message, code) => ({ message, from: -1, to: -1, code, category: classify(code).category });

// A compile envelope for a command's key: { data, errors, command } or
// { errors, command }. The user's own token reads it, so only their command is
// served.
export const buildCommandEnvelope = ({ policy }) => async ({ uid, idempotencyKey, authToken }) => {
  const commandId = commandIdFor(uid, idempotencyKey);
  let state;
  try {
    state = await policy.get({ commandId, authToken });
  } catch (e) {
    if (e instanceof PolicyRefused) return { errors: [failure(`Error: permission denied (${e.reason})`, e.reason)] };
    throw e;
  }
  const command = { commandId, outcome: state.status, statusUrl: statusUrlFor(commandId) };
  if (state.status === "completed" && state.result?.state === "available") {
    const { result } = await policy.read({ commandId, what: "result" });
    return { data: JSON.parse(result.text), errors: [], command };
  }
  return { errors: [failure(`Error: this key belongs to a command (${state.status}); read it at ${command.statusUrl}`, "command-protocol")], command };
};

// A legacy compile's outcome, as a command's would be (design §5): from the
// writes it reports. No writes: completed, or failed if it had errors.
export const legacyOutcome = envelope => {
  const effects = Array.isArray(envelope?.effects) ? envelope.effects : [];
  const statuses = effects.map(e => e.status);
  if (envelope?.responseLost || statuses.includes("uncertain")) return "uncertain";
  const errors = Array.isArray(envelope?.errors) && envelope.errors.length > 0;
  if (!statuses.length) return errors ? "failed" : "completed";
  if (statuses.every(s => s === "succeeded") && !errors) return "completed";
  if (!statuses.some(s => s === "succeeded" || s === "partial")) return "failed";
  return "partial";
};
