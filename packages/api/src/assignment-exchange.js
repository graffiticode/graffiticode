// C4's assignment exchange and submission freeze for an interpreted stage whose language is
// declared `getOrCreate` (docs/c4-l0182-assignment-plan.md decisions 1 and 7, §5; never by
// language number). data.js calls it in place of a stage's single /interpret call.
//
// The exchange: /interpret with an empty table; while the language answers
// `needsAssignment`, resolve every request in the assignment store (assignments.js) and call
// again with the fuller table. Each call must add an identity (`assignment-stalled`), and
// there are at most MAX_CALLS calls (`assignment-depth`).
//
// The freeze: an error-free result whose survey records carry a `response` answers those
// identities. Before the result is returned, they are submitted for the verified caller
// (respondent.js), in one store transaction. A record that changed meanwhile reruns the
// stage from the exchange, at most MAX_ATTEMPTS times (`assignment-contended`). The caller's
// authorized identities freeze; the rest are reads; an anonymous caller's response is a read.
// Any other refusal, temporary or not, fails the stage: the result is never served unfrozen
// to an authorized caller.
//
// The survey-record shape it reads (`{ survey: { id, sessionId, instance }, response }`) is
// the getOrCreate output contract L0182 writes; a language without it answers nothing.
import { classify } from "@graffiticode/common/failures";
import { AssignmentError, identityKey } from "./assignments.js";

export const MAX_CALLS = 16;
export const MAX_ATTEMPTS = 3;

const failedWith = (message, code, category = classify(code).category) => ({ message, from: -1, to: -1, code, category });
const failed = error => ({ failure: { data: null, errors: [error] } });

// What a store refusal becomes: its own code, or `assignment-unavailable` for anything else
// (Firestore unreachable, an unexpected error), which is temporary.
const refusedBy = e =>
  e instanceof AssignmentError
    ? failed(failedWith(`Error: ${e.message}`, e.code))
    : failed(failedWith(`Error: assignments unavailable: ${e?.message ?? e}`, "assignment-unavailable"));

// One exchange, to a final reply. Returns { reply, served } (served: key -> what the run was
// given, with its content) or { failure }.
const exchange = async ({ interpret, assignments, taskId }) => {
  const table = Object.create(null);
  const served = new Map();
  for (let call = 1; call <= MAX_CALLS; call++) {
    const reply = await interpret(table, call);
    if (reply?.responseLost) return failed(failedWith("Error: the stage's interpreter didn't answer", "compile-response-lost"));
    const requests = reply?.needsAssignment;
    if (requests === undefined) return { reply, served, calls: call };
    if (!Array.isArray(requests) || requests.length === 0) {
      return failed(failedWith("Error: the stage asked for no assignment it could be given", "assignment-stalled"));
    }
    for (const request of requests) {
      if (typeof request?.key !== "string" || Object.hasOwn(table, request.key)) {
        return failed(failedWith("Error: the stage asked again for an assignment it was given", "assignment-stalled"));
      }
    }
    let resolved;
    try {
      resolved = await assignments.resolve({ requests, taskId });
    } catch (e) {
      return refusedBy(e);
    }
    for (const request of requests) {
      const entry = resolved.table[request.key];
      if (!entry) return failed(failedWith("Error: an assignment the stage asked for wasn't given", "assignment-stalled"));
      table[request.key] = entry;
      if (entry.absent) continue;
      const content = entry.content ??
        request.candidates?.find(c => c.instance === entry.instance && c.digest === entry.digest)?.content;
      served.set(request.key, {
        survey: request.identity.survey,
        session: request.identity.session,
        instance: entry.instance,
        digest: entry.digest,
        content,
      });
    }
  }
  return failed(failedWith(`Error: the stage needed more than ${MAX_CALLS} assignment exchanges`, "assignment-depth"));
};

// The identities an error-free result answers: survey records with a response, for an
// identity this run was served, at the version it was served.
export const answeredIdentities = (data, served) => {
  const found = new Map();
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const survey = value.survey;
    if (survey && typeof survey === "object" && typeof survey.id === "string" && typeof survey.sessionId === "string" &&
      Object.hasOwn(value, "response")) {
      const key = identityKey(survey.id, survey.sessionId);
      const given = served.get(key);
      if (given && given.instance === survey.instance && typeof given.content === "string") found.set(key, { key, ...given });
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(data);
  return [...found.values()];
};

// `interpret(table, call)`: the stage's /interpret call with that table. Returns
// { reply, calls, submission } or { failure } (an envelope with the stage's error).
export const runAssignedStage = async ({ interpret, assignments, respondentAuthority = null, caller = null, taskId }) => {
  if (!assignments) return failed(failedWith("Error: this api has no assignment store", "assignment-unavailable"));
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const run = await exchange({ interpret, assignments, taskId });
    if (run.failure) return run;
    const { reply, served, calls } = run;
    if (reply?.errors?.length) return { reply, calls, submission: null };
    const used = answeredIdentities(reply?.data, served);
    if (used.length === 0) return { reply, calls, submission: null };
    // The caller context is built only now, when there is something to freeze: a request
    // with no response never verifies a frontend identity. A supplied identity that doesn't
    // verify fails the stage, never reads as absent.
    let context;
    try {
      context = typeof caller === "function" ? await caller() : caller;
    } catch (e) {
      const reason = typeof e?.reason === "string" ? e.reason : "frontend-identity-invalid";
      return failed(failedWith(`Error: ${e?.message ?? "the caller couldn't be identified"}`, reason));
    }
    const principal = context?.principal ?? null;
    if (!principal) return { reply, calls, submission: { status: "read", reason: "respondent-anonymous" } };
    const sessions = [...new Set(used.map(u => u.session))];
    let derived = Object.create(null);
    try {
      // Only unbound sessions are asked of the console; bound ones are decided by their
      // binding inside the freeze.
      const unbound = await assignments.unboundSessions(sessions);
      if (respondentAuthority && unbound.length > 0) derived = await respondentAuthority(unbound);
    } catch (e) {
      return refusedBy(e);
    }
    try {
      const submission = await assignments.submit({ taskId, caller: principal, submitter: principal, used, derived });
      return { reply, calls, submission };
    } catch (e) {
      if (e instanceof AssignmentError && e.code === "assignment-changed") continue;
      return refusedBy(e);
    }
  }
  return failed(failedWith(`Error: the stage's assignments kept changing, after ${MAX_ATTEMPTS} tries`, "assignment-contended"));
};
