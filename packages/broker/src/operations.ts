/* eslint-disable camelcase -- Learnosity wire fields are snake_case */
// Named operations. Each validates a CONSTRAINED payload and builds the
// provider request itself — none is a general signer or proxy. The broker
// supplies identity fields (consumer key, domain, user id); a payload can never
// set them.

import { randomUUID } from "node:crypto";
import { argsDigest } from "./canonical.js";

export class PayloadRejected extends Error {}

// The provider definitely did not apply the request. Any other error from a
// provider call is an uncertain outcome: the request may have been applied
// before its response was lost.
export class ProviderRejected extends Error {}

// The operation's deadline passed before its next provider request started:
// that request was never sent, so like a rejection it is definite.
export class DeadlineExceeded extends Error {}

const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
const isRef = v => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,250}$/.test(v);

const onlyKeys = (obj, allowed, where) => {
  if (!isPlainObject(obj)) throw new PayloadRejected(`${where} must be an object`);
  const extra = Object.keys(obj).filter(k => !allowed.includes(k));
  if (extra.length) throw new PayloadRejected(`${where} has unsupported fields: ${extra.join(", ")}`);
};

// What an inline Questions API / Items API preview may carry: the rendered
// questions and their dynamic data. No user, domain, security or mode fields.
const PREVIEW_KEYS = ["id", "name", "questions", "session_id", "dynamic_content_data", "type"];

const validatePreview = payload => {
  onlyKeys(payload, PREVIEW_KEYS, "preview");
  if (!Array.isArray(payload.questions)) throw new PayloadRejected("preview.questions must be a list");
  payload.questions.forEach((q, i) => {
    if (!isPlainObject(q) || typeof q.type !== "string" || !isRef(q.response_id)) {
      throw new PayloadRejected(`preview.questions[${i}] needs a type and response_id`);
    }
  });
};

// WRITE-02 (W5 stage 3): what lets a later reconciliation tell that this
// operation's write of a record landed. Broker writes the operation id into
// every record it saves, in a field that persists without affecting the
// item (sandbox spike, 2026-10-14): a question's data.metadata and an item's
// metadata. Finding this operation's mark on a stored record proves its write
// of that record landed, whatever happened since. A program can't set it.
export const MARK_KEY = "gc_operation";
export const EVIDENCE_FORMAT = 1;
// The fields compared for each record kind, format 1, as the program sent
// them (before the mark is added).
export const EVIDENCE_PROJECTION = Object.freeze({
  questions: Object.freeze(["type", "data"]),
  items: Object.freeze(["definition", "questions", "status", "metadata"]),
});
const withoutMark = metadata => {
  if (!isPlainObject(metadata)) return metadata;
  const { [MARK_KEY]: _mark, ...rest } = metadata;
  return rest;
};
const project = (record, fields) => Object.fromEntries(fields.filter(f => record[f] !== undefined).map(f => [f, record[f]]));

// Recorded on the receipt's claim, in the same create, before any provider
// request: one entry per record the operation writes, in dispatch order.
export const writeEvidence = ({ questionRecords, itemRecords }) => ({
  format: EVIDENCE_FORMAT,
  projection: EVIDENCE_PROJECTION,
  mark: { questions: `data.metadata.${MARK_KEY}`, items: `metadata.${MARK_KEY}` },
  records: [
    ...questionRecords.map(q => ({ step: "questions", kind: "question", reference: q.reference, digest: argsDigest(project(q, EVIDENCE_PROJECTION.questions)) })),
    ...itemRecords.map(it => ({ step: "items", kind: "item", reference: it.reference, digest: argsDigest(project(it, EVIDENCE_PROJECTION.items)) })),
  ],
});

// The records as Broker sends them: each carries this operation's mark.
const marked = ({ questionRecords, itemRecords }, operationId) => ({
  questionRecords: questionRecords.map(q => ({ ...q, data: { ...q.data, metadata: { ...withoutMark(q.data.metadata ?? {}), [MARK_KEY]: operationId } } })),
  itemRecords: itemRecords.map(it => ({ ...it, metadata: { ...withoutMark(it.metadata ?? {}), [MARK_KEY]: operationId } })),
});

const validateWrite = payload => {
  onlyKeys(payload, ["questionRecords", "itemRecords"], "write");
  const { questionRecords, itemRecords } = payload;
  if (!Array.isArray(questionRecords) || questionRecords.length === 0) {
    throw new PayloadRejected("write.questionRecords must be a non-empty list");
  }
  if (!Array.isArray(itemRecords)) throw new PayloadRejected("write.itemRecords must be a list");
  questionRecords.forEach((q, i) => {
    onlyKeys(q, ["type", "reference", "data"], `write.questionRecords[${i}]`);
    if (typeof q.type !== "string" || !isRef(q.reference) || !isPlainObject(q.data)) {
      throw new PayloadRejected(`write.questionRecords[${i}] needs type, reference and data`);
    }
    if (q.data.metadata !== undefined && !isPlainObject(q.data.metadata)) {
      throw new PayloadRejected(`write.questionRecords[${i}].data.metadata must be an object`);
    }
    if (isPlainObject(q.data.metadata) && Object.prototype.hasOwnProperty.call(q.data.metadata, MARK_KEY)) {
      throw new PayloadRejected(`write.questionRecords[${i}].data.metadata.${MARK_KEY} is set by Broker, never by a program`);
    }
  });
  itemRecords.forEach((it, i) => {
    if (!isPlainObject(it) || !isRef(it.reference)) {
      throw new PayloadRejected(`write.itemRecords[${i}] needs a reference`);
    }
    if (it.metadata !== undefined && !isPlainObject(it.metadata)) {
      throw new PayloadRejected(`write.itemRecords[${i}].metadata must be an object`);
    }
    if (isPlainObject(it.metadata) && Object.prototype.hasOwnProperty.call(it.metadata, MARK_KEY)) {
      throw new PayloadRejected(`write.itemRecords[${i}].metadata.${MARK_KEY} is set by Broker, never by a program`);
    }
    // Saves land as drafts. Publishing is an Author Site action, never a save.
    if (it.status !== "unpublished") {
      throw new PayloadRejected(`write.itemRecords[${i}] must have status "unpublished"`);
    }
  });
};

export const buildOperations = ({ sdk, domain, dataApi }) => {
  const consumer = key => ({ consumer_key: key, domain, user_id: randomUUID() });
  return {
    "learnosity.sign-questions-preview": {
      kind: "sign",
      validate: validatePreview,
      run: async (payload, { key, secret }) => ({ request: sdk.init("questions", consumer(key), secret, payload) }),
    },
    "learnosity.sign-items-preview": {
      kind: "sign",
      validate: validatePreview,
      run: async (payload, { key, secret }) => ({ request: sdk.init("items", consumer(key), secret, payload) }),
    },
    "learnosity.write-items": {
      kind: "write",
      validate: validateWrite,
      evidence: writeEvidence,
      // Two provider writes: questions first (items reference them), then
      // items. Each step's status is reported so a failure after the first is
      // visible as `partial` rather than retried. `providerCall` (from the
      // broker) authorizes each request and refuses to start one past the
      // operation's deadline, then gives it its timeout.
      run: async (payload, { key, secret }, { onStep, providerCall, operationId }) => {
        if (typeof operationId !== "string" || !operationId) throw new Error("a write needs its operation id, for the mark");
        const { questionRecords, itemRecords } = marked(payload, operationId);
        // `providerCall(step)` authorizes this registered step (W2), then
        // gives the request its timeout.
        const write = async (step, route, body) => {
          const timeoutMs = await providerCall(step);
          return dataApi({ route, request: sdk.init("data", { consumer_key: key, domain }, secret, body, "set"), timeoutMs });
        };
        await write("questions", "/itembank/questions", { questions: questionRecords });
        await onStep("questions");
        if (itemRecords.length > 0) {
          await write("items", "/itembank/items", { items: itemRecords });
          await onStep("items");
        }
        return {
          saved: true,
          references: (itemRecords.length ? itemRecords : questionRecords).map(r => r.reference),
          questionReferences: questionRecords.map(r => r.reference),
        };
      },
    },
  };
};
