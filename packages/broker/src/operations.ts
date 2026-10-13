/* eslint-disable camelcase -- Learnosity wire fields are snake_case */
// Named operations. Each validates a CONSTRAINED payload and builds the
// provider request itself — none is a general signer or proxy. The broker
// supplies identity fields (consumer key, domain, user id); a payload can never
// set them.

import { randomUUID } from "node:crypto";

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
  });
  itemRecords.forEach((it, i) => {
    if (!isPlainObject(it) || !isRef(it.reference)) {
      throw new PayloadRejected(`write.itemRecords[${i}] needs a reference`);
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
      // Two provider writes: questions first (items reference them), then
      // items. Each step's status is reported so a failure after the first is
      // visible as `partial` rather than retried. `providerCall` (from the
      // broker) authorizes each request and refuses to start one past the
      // operation's deadline, then gives it its timeout.
      run: async ({ questionRecords, itemRecords }, { key, secret }, { onStep, providerCall }) => {
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
