// C4's durable survey assignments: the api's store (docs/c4-l0182-assignment-plan.md
// decisions 2, 5–7 and 10–12, §5; the runtime and lifecycle policies the owner selected in
// docs/c4-runtime-lifecycle.md §10; the continuation protocol (c) in
// docs/c4-continuation-race-review.md §5, as the merged harness in
// docs/evidence/interpreter-c4-l0182/continuation-harness/ models it).
//
// UNWIRED: nothing imports this module yet. interpret.js integration, the continuation
// routes, the manifest declaration, Firestore rules and indexes, and deployment are later,
// separately approved slices.
//
//   resolve({ requests, taskId })
//     -> { namespace, table, created }
//     One transaction: the cutover state, the task's quarantine, every identity's record and
//     the draw cycles they touch. `requests` are L0182's `needsAssignment` requests
//     ({ identity: { survey, session }, key, ordinal, candidates: [{ instance, digest, content }] });
//     `table` maps each key to `{ instance, digest, content? }` or `{ absent: true }`, the
//     table L0182 resolves from.
//
//   submit({ taskId, caller, submitter, used, derived })
//     -> { status: "frozen" | "read", namespace, frozen, already, read: [{ key, reason }] }
//     The freeze, one transaction. Per session, the caller holds its authority or the
//     response is a read for it; the authorized identities freeze together or not at all,
//     and a submission with none is a read, which writes nothing. `used` is every identity the interpret
//     served and the response answers ({ key, survey, session, instance, digest, content });
//     `derived` the console's respondent-authority answer for each unbound session.
//
//   retained(digest) -> content | undefined
//   setCutover({ namespace, from, to })   compare-and-set of the cutover state
//
// Errors are AssignmentError(code, { temporary }). A temporary one means "retry"; nothing a
// refused transaction meant to write is written.
//
// Storage, every document server-only and read by id (no index needed):
//   l0182-session-namespace/<sha256(session)>   the session's pinned namespace (create-only)
//   <ns>l0182-assignments/<sha256(key)>          one record per (survey ref, session)
//   <ns>l0182-draw-cycles/<survey id>            the draw without replacement
//   <ns>l0182-survey-models/<digest>             retained content (create-only, byte-identical)
//   <ns>l0182-cutover/state                      backfill | reconciling | done
//   <ns>l0182-task-quarantine/<sha256(taskId)>   written by the backfill; blocks the task
//   <ns>respondent-bindings/<sha256(session)>    option (c)'s binding pointer (read here)
// where <ns> is "" for production and "canary-" for the canary namespace. Nothing here is
// ever deleted (§5 retention): a frozen record and a retained model never change.

import { createHash, randomInt } from "node:crypto";
import { admin } from "./storage/firebase.js";

export class AssignmentError extends Error {
  /**
   * @param {string} code
   * @param {{ temporary?: boolean, detail?: string }} [options]
   */
  constructor(code, { temporary = false, detail = undefined } = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.temporary = temporary;
  }
}

/** @type {(code: string, opts?: { temporary?: boolean, detail?: string }) => never} */
const refuse = (code, opts) => {
  throw new AssignmentError(code, opts);
};

export const NAMESPACES = ["production", "canary"];

// Why a response is a read rather than a submission, for one session (decision 3).
const READ = {
  notRespondent: { reason: "not-respondent" },
  unknown: { reason: "respondent-unknown" },
  ambiguous: { reason: "respondent-ambiguous" },
};
export const CUTOVER_STATES = ["backfill", "reconciling", "done"];

const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");

// JSON with sorted keys, for full-principal equality.
const canonical = value =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.keys(value)
          .filter(k => value[k] !== undefined)
          .sort()
          .map(k => `${JSON.stringify(k)}:${canonical(value[k])}`)
          .join(",")}}`;

// Decision 3: a principal is { kind: "user", uid, installation } or
// { kind: "freePlan", uid, workspace, installation }, compared on every field. A free-plan
// principal without a workspace is unattested, never matched by uid.
const PRINCIPAL_FIELDS = { user: ["kind", "uid", "installation"], freePlan: ["kind", "uid", "workspace", "installation"] };

export const validPrincipal = principal => {
  const fields = principal && PRINCIPAL_FIELDS[principal.kind];
  return Boolean(fields) &&
    Object.keys(principal).length === fields.length &&
    fields.every(f => typeof principal[f] === "string" && principal[f].length > 0);
};

export const samePrincipal = (a, b) => validPrincipal(a) && validPrincipal(b) && canonical(a) === canonical(b);

// The identity's table key, as L0182 writes it (assigned::key): the JSON text of [ref, session].
export const identityKey = (survey, session) => JSON.stringify([survey, session]);

// A session is any non-empty string L0182 accepts (a slash included). Documents keyed by a
// session (its pin and its binding) use its digest as their id, and keep the session itself
// as a field: Firestore's id rules never become the language's.
const validSession = session => typeof session === "string" && session.length > 0;
export const sessionDocId = session => sha256(session);

// A named ref is served only as itself; a survey id only as <id>-<n> (decision 10).
const isVersionOf = (instance, survey, named) =>
  named ? instance === survey : instance.startsWith(`${survey}-`) && /^\d+$/.test(instance.slice(survey.length + 1));

export const buildAssignmentStore = ({
  db = admin.firestore(),
  // Prepended to every collection; tests isolate themselves with it. Production uses "".
  prefix = "",
  canarySessions = [],
  canaryPrincipals = [],
  now = Date.now,
  pick = n => randomInt(n),
} = {}) => {
  const listed = new Set(canarySessions);
  const canaryOwned = principal => canaryPrincipals.some(p => samePrincipal(p, principal));
  // Every namespace is checked before a reference is built: an unknown one never falls back
  // to production.
  const col = (namespace, name) => {
    if (!NAMESPACES.includes(namespace)) refuse("namespace-invalid", { detail: String(namespace) });
    return db.collection(`${prefix}${namespace === "canary" ? "canary-" : ""}${name}`);
  };
  const refs = namespace => ({
    record: key => col(namespace, "l0182-assignments").doc(sha256(key)),
    cycle: survey => col(namespace, "l0182-draw-cycles").doc(survey),
    model: digest => col(namespace, "l0182-survey-models").doc(digest),
    cutover: () => col(namespace, "l0182-cutover").doc("state"),
    quarantine: taskId => col(namespace, "l0182-task-quarantine").doc(sha256(taskId)),
    binding: session => col(namespace, "respondent-bindings").doc(sessionDocId(session)),
  });
  const pinRef = session => db.collection(`${prefix}l0182-session-namespace`).doc(sessionDocId(session));

  // The production cutover starts in `backfill` (decision 10), so a missing state refuses
  // every api write. The canary namespace's is `done` from the start (decision 12).
  const cutoverState = (namespace, snap) =>
    snap.exists ? snap.data().state : namespace === "canary" ? "done" : "backfill";

  // Reads each session's pin and decides the namespace: the pin, or, for a session never
  // seen, the configured list. Every session must land in one namespace.
  const namespaceFor = async (tx, sessions) => {
    const pins = await Promise.all(sessions.map(s => tx.get(pinRef(s))));
    const spaces = sessions.map((s, i) => pins[i].exists ? pins[i].data().namespace : listed.has(s) ? "canary" : "production");
    for (const space of spaces) {
      if (!NAMESPACES.includes(space)) refuse("namespace-invalid", { detail: String(space) });
    }
    if (new Set(spaces).size > 1) refuse("namespace-mixed");
    return { namespace: spaces[0] ?? "production", missingPins: sessions.filter((_, i) => !pins[i].exists) };
  };
  const writePins = (tx, sessions, namespace) => {
    for (const session of sessions) tx.create(pinRef(session), { session, namespace, at: now() });
  };

  // Today's draw without replacement, made durable (§3): restrict the taken set to the
  // current candidates, refill when every one is taken, pick uniformly among the untaken.
  const draw = (cycle, candidates) => {
    const names = candidates.map(c => c.instance);
    let taken = (cycle.taken ?? []).filter(i => names.includes(i));
    let number = cycle.cycle ?? 0;
    if (names.every(i => taken.includes(i))) {
      taken = [];
      number += 1;
    }
    const untaken = candidates.filter(c => !taken.includes(c.instance));
    const chosen = untaken[pick(untaken.length)];
    return { chosen, cycle: { cycle: number, taken: [...taken, chosen.instance], candidates: names } };
  };

  const checkRequest = request => {
    const survey = request?.identity?.survey;
    const session = request?.identity?.session;
    if (typeof survey !== "string" || !validSession(session)) {
      refuse("assignment-request-invalid", { detail: "identity" });
    }
    if (request.key !== identityKey(survey, session)) refuse("assignment-request-invalid", { detail: "key" });
    if (!Array.isArray(request.candidates)) refuse("assignment-request-invalid", { detail: "candidates" });
    for (const c of request.candidates) {
      if (typeof c?.instance !== "string" || typeof c.content !== "string" || c.digest !== sha256(c.content)) {
        refuse("assignment-request-invalid", { detail: "candidate" });
      }
    }
    const named = request.candidates.some(c => c.instance === survey);
    for (const c of request.candidates) {
      if (!isVersionOf(c.instance, survey, named)) refuse("assignment-request-invalid", { detail: c.instance });
    }
    return { survey, session, named };
  };

  const resolve = async ({ requests, taskId }) => {
    const checked = requests.map(request => ({ request, ...checkRequest(request) }));
    const sessions = [...new Set(checked.map(c => c.session))];
    return db.runTransaction(async tx => {
      const { namespace, missingPins } = await namespaceFor(tx, sessions);
      const r = refs(namespace);
      const [cutoverSnap, quarantineSnap] = await Promise.all([tx.get(r.cutover()), tx.get(r.quarantine(taskId))]);
      // Checked first: a quarantined task creates nothing (decision 10).
      if (quarantineSnap.exists) refuse("assignment-under-review", { detail: "task" });
      const writable = cutoverState(namespace, cutoverSnap) === "done";
      const unique = [...new Map(checked.map(c => [c.request.key, c])).values()];
      const records = await Promise.all(unique.map(c => tx.get(r.record(c.request.key))));
      const cycles = new Map();
      const models = new Map();
      // Every read before any write: the cycles a draw may touch, and the retained models a
      // frozen record may need.
      for (const [i, c] of unique.entries()) {
        const record = records[i].exists ? records[i].data() : null;
        if (record?.state === "unresolved") refuse("assignment-under-review", { detail: c.request.key });
        if (record?.frozen) {
          if (!c.request.candidates.some(x => x.instance === record.instance && x.digest === record.digest)) {
            models.set(record.digest, null);
          }
        } else if (!c.named && c.request.candidates.length > 0 && !cycles.has(c.survey)) {
          cycles.set(c.survey, null);
        }
      }
      await Promise.all([
        ...[...cycles.keys()].map(async survey => cycles.set(survey, (await tx.get(r.cycle(survey))).data() ?? {})),
        ...[...models.keys()].map(async digest => models.set(digest, (await tx.get(r.model(digest))).data() ?? null)),
      ]);

      // Keyed by caller-controlled strings: never an object with a prototype.
      const table = Object.create(null);
      const created = [];
      const writes = [];
      const touched = new Set();
      const written = new Set();
      const requireWritable = key => {
        if (!writable) refuse("assignment-reconciling", { temporary: true, detail: key });
      };
      for (const [i, c] of unique.entries()) {
        const { key, candidates } = c.request;
        const ref = r.record(key);
        const record = records[i].exists ? records[i].data() : null;
        if (record?.frozen) {
          // Frozen: never changes. Its content from the candidates while they still have its
          // digest, otherwise retained.
          const entry = { instance: record.instance, digest: record.digest };
          if (models.has(record.digest)) {
            const model = models.get(record.digest);
            if (!model) refuse("assignment-model-missing", { detail: key });
            entry.content = model.content;
          }
          table[key] = entry;
          continue;
        }
        if (candidates.length === 0) {
          // Nothing to serve and nothing retained: today's "no survey" (decision 2).
          table[key] = { absent: true };
          continue;
        }
        const current = record && candidates.find(x => x.instance === record.instance);
        if (current && current.digest === record.digest) {
          table[key] = { instance: record.instance, digest: record.digest };
          continue;
        }
        requireWritable(key);
        written.add(c.session);
        if (current) {
          // The same instance, new content, nobody answered against the old (§4): move.
          const history = [...(record.digestHistory ?? []), { from: record.digest, to: current.digest, at: now() }];
          writes.push(() => tx.update(ref, { digest: current.digest, digestHistory: history, updatedAt: now() }));
          table[key] = { instance: current.instance, digest: current.digest };
          continue;
        }
        // No record, or its version was removed: assign afresh.
        let chosen;
        let cycle = null;
        if (c.named) {
          chosen = candidates.find(x => x.instance === c.survey);
        } else {
          ({ chosen, cycle } = draw(cycles.get(c.survey), candidates));
          cycles.set(c.survey, cycle);
          touched.add(c.survey);
        }
        const fields = {
          key,
          survey: c.survey,
          session: c.session,
          state: "assigned",
          instance: chosen.instance,
          digest: chosen.digest,
          cycle: cycle?.cycle ?? null,
          drawnAt: now(),
        };
        if (record) {
          const reassigned = [...(record.reassigned ?? []), { from: record.instance, digest: record.digest, at: now() }];
          writes.push(() => tx.update(ref, { ...fields, reassigned, updatedAt: now() }));
        } else {
          writes.push(() => tx.create(ref, { ...fields, createdAt: now(), taskId, digestHistory: [] }));
          created.push(key);
        }
        table[key] = { instance: chosen.instance, digest: chosen.digest };
      }
      for (const survey of touched) writes.push(() => tx.set(r.cycle(survey), cycles.get(survey)));
      // A session is pinned by the first transaction that writes for it.
      writes.push(() => writePins(tx, missingPins.filter(s => written.has(s)), namespace));
      writes.forEach(write => write());
      return { namespace, table, created };
    });
  };

  const submit = async ({ taskId, caller, submitter = caller, used, derived = {} }) => {
    if (!Array.isArray(used) || used.length === 0) refuse("assignment-request-invalid", { detail: "used" });
    if (caller?.kind === "freePlan" && !caller.workspace) refuse("respondent-unattested", { temporary: true });
    if (!validPrincipal(caller) || !validPrincipal(submitter)) refuse("principal-invalid");
    for (const u of used) {
      if (!validSession(u.session) || u.key !== identityKey(u.survey, u.session) ||
        typeof u.content !== "string" || sha256(u.content) !== u.digest) {
        refuse("assignment-request-invalid", { detail: u.key });
      }
    }
    const sessions = [...new Set(used.map(u => u.session))];
    return db.runTransaction(async tx => {
      const { namespace, missingPins } = await namespaceFor(tx, sessions);
      if (namespace === "canary" && !(canaryOwned(caller) && canaryOwned(submitter))) refuse("canary-fixture-only");
      const r = refs(namespace);
      const [cutoverSnap, quarantineSnap] = await Promise.all([tx.get(r.cutover()), tx.get(r.quarantine(taskId))]);
      if (quarantineSnap.exists) refuse("assignment-under-review", { detail: "task" });
      const bindings = await Promise.all(sessions.map(s => tx.get(r.binding(s))));
      const records = await Promise.all(used.map(u => tx.get(r.record(u.key))));
      const digests = [...new Set(used.map(u => u.digest))];
      const models = await Promise.all(digests.map(d => tx.get(r.model(d))));

      // Authority, per session, read inside this transaction (option (c), §1.3). A session the
      // caller doesn't hold is a read; one that can't be decided now refuses the whole
      // submission temporarily, since its classification is unknown.
      // Keyed by session, which may be any string ("constructor", "__proto__", …): Maps, so
      // no lookup ever reads an inherited property.
      const authority = new Map();
      const readReason = new Map();
      for (const [i, session] of sessions.entries()) {
        const binding = bindings[i].exists ? bindings[i].data() : null;
        if (binding?.prepared) refuse("respondent-continuing", { temporary: true, detail: session });
        let held;
        if (binding?.active) {
          held = { principal: binding.active.principal, revision: binding.active.revision, basis: "binding" };
        } else {
          // Only the caller's own answer for this session counts, never an inherited property.
          const answer = Object.hasOwn(derived ?? {}, session) ? derived[session] : undefined;
          if (!answer) refuse("respondent-authority-unavailable", { temporary: true, detail: session });
          if (answer.unknown || answer.ambiguous || !answer.principal) {
            readReason.set(session, (answer.ambiguous ? READ.ambiguous : READ.unknown).reason);
            continue;
          }
          held = { principal: answer.principal, revision: 0, basis: "derived" };
        }
        if (samePrincipal(caller, held.principal)) authority.set(session, held);
        else readReason.set(session, READ.notRespondent.reason);
      }
      const read = used.filter(u => readReason.has(u.session)).map(u => ({ key: u.key, reason: readReason.get(u.session) }));
      const authorized = used.map((u, i) => ({ u, snap: records[i] })).filter(({ u }) => authority.has(u.session));
      // Nothing the caller may freeze: a read, which writes nothing and so is never fenced.
      if (authorized.length === 0) return { status: "read", namespace, frozen: [], already: [], read };
      // The authorized subset freezes atomically; it is a write, fenced by the cutover.
      if (cutoverState(namespace, cutoverSnap) !== "done") refuse("assignment-reconciling", { temporary: true });

      // Every authorized identity must still hold exactly the version and digest the
      // interpret used.
      const frozen = [];
      const already = [];
      const writes = [];
      for (const { u, snap } of authorized) {
        const record = snap.exists ? snap.data() : null;
        if (!record || record.state === "unresolved" || record.instance !== u.instance || record.digest !== u.digest) {
          refuse("assignment-changed", { temporary: true, detail: u.key });
        }
        if (record.frozen) {
          already.push(u.key); // an idempotent retry, or the current respondent again: never rewritten
          continue;
        }
        const { principal, revision, basis } = authority.get(u.session);
        writes.push(() => tx.update(r.record(u.key), {
          state: "frozen",
          frozen: { principal, revision, basis, submitter, taskId, submittedAt: now() },
        }));
        frozen.push(u.key);
      }
      // Success is acknowledged only with every authorized identity's model retained: created
      // now, or restored for an already-frozen record whose model is missing, from bytes whose
      // digest is the record's own (checked above). Existing bytes must be identical.
      for (const [i, digest] of digests.entries()) {
        if (!authorized.some(({ u }) => u.digest === digest)) continue;
        const content = authorized.find(({ u }) => u.digest === digest).u.content;
        if (models[i].exists) {
          if (models[i].data().content !== content) refuse("survey-model-conflict", { detail: digest });
        } else {
          writes.push(() => tx.create(r.model(digest), { digest, content, at: now() }));
        }
      }
      const written = new Set(authorized.map(({ u }) => u.session));
      writes.push(() => writePins(tx, missingPins.filter(s => written.has(s)), namespace));
      writes.forEach(write => write());
      return { status: "frozen", namespace, frozen, already, read };
    });
  };

  const retained = async (digest, { namespace = "production" } = {}) =>
    (await refs(namespace).model(digest).get()).data()?.content;

  const setCutover = ({ namespace = "production", from, to }) => {
    if (!CUTOVER_STATES.includes(to)) refuse("cutover-invalid", { detail: to });
    return db.runTransaction(async tx => {
      const ref = refs(namespace).cutover();
      const snap = await tx.get(ref);
      const state = cutoverState(namespace, snap);
      if (state !== from) refuse("cutover-changed", { detail: state });
      tx.set(ref, { state: to, at: now() });
      return { from, to };
    });
  };

  return { resolve, submit, retained, setCutover, refs, pinRef };
};
