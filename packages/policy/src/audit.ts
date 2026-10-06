// Security audit records. One record per decision — allowed or denied — with
// principals pseudonymized: Graffiticode uids can be wallet addresses, which
// must never be logged. Records never carry tokens, secrets, request bodies or
// argument values; an args digest is the most a record says about a request.
//
// The field allowlist is not enough on its own (spec AUDIT-01): a refused
// request can put an email or payload text in a field a record copies, such
// as `op`. So every field also has a validator. Names come from the registry,
// identifiers must have their bounded server-side form, enumerations their
// listed values; anything else is recorded as "invalid", never as given.

import { createHmac, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { OPERATIONS, operationSteps, protectedFunctionsForLang } from "@graffiticode/common/protected-registry";
import { REASON_CATEGORIES, FAILURE_CATEGORIES, underlyingReason } from "@graffiticode/common/failures";

export const createPseudonymizer = ({ secret }) => {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new Error("audit pseudonymization secret must be at least 16 characters");
  }
  return value =>
    value == null ? null : createHmac("sha256", secret).update(String(value)).digest("hex").slice(0, 24);
};

// The request a record belongs to (spec AUDIT-01 correlation). Each HTTP
// request runs inside its own context with a server-generated id
// (requestContextMiddleware); a record written within it carries that id, so
// even a refusal before any invocation or verified token is traceable.
const requestContext = new AsyncLocalStorage<{ requestId: string }>();
export const requestContextMiddleware = (_req, _res, next) => requestContext.run({ requestId: randomUUID() }, next);
export const currentRequestId = () => requestContext.getStore()?.requestId;

const INVALID = "invalid";
const match = re => v => (typeof v === "string" && re.test(v) ? v : INVALID);
const oneOf = values => v => (values.includes(v) ? v : INVALID);
const SLUG = /^[a-z][a-z0-9-]{0,47}$/;
const UUIDISH = /^[A-Za-z0-9-]{8,64}$/;
// Ids as servers mint them: never an address, an email or free text.
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const notAnAddress = v => (typeof v === "string" && /^0x[0-9a-fA-F]{6,}/.test(v) ? INVALID : v);
const id = v => notAnAddress(match(ID)(v));

// Reasons a record may carry: every classified refusal (possibly wrapped by
// Broker), and the annotations of allowed or recorded outcomes.
const ANNOTATIONS = [
  "canary-during-maintenance", "system-preview", "publication", "new", "reused", "outcome-not-recorded",
  "unclassified-reason", "succeeded", "failed", "partial", "uncertain",
];
const reason = v => {
  if (typeof v !== "string") return INVALID;
  if (ANNOTATIONS.includes(v) || REASON_CATEGORIES[underlyingReason(v)]) return v;
  return INVALID;
};

// Registry-derived names, checked against the record's own context.
const op = v => (typeof v === "string" && Object.prototype.hasOwnProperty.call(OPERATIONS, v) ? v : INVALID);

const VALIDATORS = {
  event: match(SLUG),
  outcome: oneOf(["allowed", "denied", "succeeded", "failed", "partial", "uncertain", "replayed"]),
  reason,
  category: oneOf([...FAILURE_CATEGORIES]),
  lang: match(/^\d{4}$/),
  op,
  purpose: oneOf(["dispatch", "sign", "replay"]),
  connectionId: v => notAnAddress(match(/^conn-[A-Za-z0-9_-]{1,120}$/)(v)),
  registryVersion: v => (Number.isInteger(v) ? v : INVALID),
  decisionId: match(UUIDISH),
  jti: match(UUIDISH),
  opid: v => notAnAddress(match(/^[A-Za-z0-9_.:-]{1,128}\/[A-Za-z0-9_.:-]{1,64}\/[A-Za-z0-9_.:-]{1,128}$/)(v)),
  invocationId: v => notAnAddress(match(/^(inv|sys)-[A-Za-z0-9-]{1,64}$/)(v)),
  stage: id,
  publicationId: v => notAnAddress(match(/^pub-[A-Za-z0-9_-]{1,120}$/)(v)),
  requestId: match(UUIDISH),
  attemptId: match(UUIDISH),
  provenance: oneOf(["user", "publication", "system"]),
  callerRole: oneOf(["broker", "compiler", "console", "gateway", "policy"]),
};
// `fn` and `step` need the record's lang and op to be checked.
const fnFor = (fn, lang) => (typeof fn === "string" && Object.prototype.hasOwnProperty.call(protectedFunctionsForLang(lang) || {}, fn) ? fn : INVALID);
const stepFor = (step, recordOp) => (typeof step === "string" && (operationSteps(recordOp) || []).some(s => s.id === step) ? step : INVALID);
const stepsFor = (steps, recordOp) => (Array.isArray(steps) ? steps.map(s => stepFor(s, recordOp)) : INVALID);

export const AUDIT_FIELDS = Object.freeze([...Object.keys(VALIDATORS), "fn", "step", "failedStep", "steps"]);

// `validate` exposes the per-field checks for tests.
export const validateAuditRecord = record => {
  const out: Record<string, unknown> = {};
  for (const [field, check] of Object.entries(VALIDATORS)) {
    if (record[field] !== undefined) out[field] = check(record[field]);
  }
  const recordOp = record.op;
  if (record.fn !== undefined) out.fn = fnFor(record.fn, record.lang);
  if (record.step !== undefined) out.step = stepFor(record.step, recordOp);
  if (record.failedStep !== undefined) out.failedStep = stepFor(record.failedStep, recordOp);
  if (record.steps !== undefined) out.steps = stepsFor(record.steps, recordOp);
  return out;
};

export const createAudit = ({ sink, pseudonymize }) => record => {
  const requestId = record.requestId ?? currentRequestId();
  const out: Record<string, unknown> = { at: new Date().toISOString(), ...validateAuditRecord({ ...record, requestId }) };
  if (record.uid !== undefined) out.user = pseudonymize(record.uid);
  if (record.ownerUid !== undefined) out.owner = pseudonymize(record.ownerUid);
  return sink(out);
};
