// Named operations. Each validates a CONSTRAINED payload and builds the
// provider request itself — none is a general signer or proxy. The broker
// supplies identity fields (consumer key, domain, user id); a payload can never
// set them.

import { randomUUID } from "node:crypto";

export class PayloadRejected extends Error {}

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

// The widget types an Author Site session may offer (L0176's allowlist).
export const AUTHOR_WIDGET_TYPES = Object.freeze([
  "mcq", "shorttext", "longtextV2", "plaintext", "clozetext", "clozeassociation", "clozedropdown",
  "clozeformulaV2", "choicematrix", "orderlist", "classification", "bowtie", "tokenhighlight",
  "association", "graphplotting", "hotspot", "imageclozeassociationV2", "imageclozetext", "numberline"
]);

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
    "learnosity.sign-author": {
      kind: "sign",
      validate: payload => {
        onlyKeys(payload, ["reference", "widgetTypes"], "author");
        if (!isRef(payload.reference)) throw new PayloadRejected("author.reference is required");
        const types = payload.widgetTypes ?? AUTHOR_WIDGET_TYPES;
        if (!Array.isArray(types) || !types.every(t => AUTHOR_WIDGET_TYPES.includes(t))) {
          throw new PayloadRejected("author.widgetTypes must come from the allowlist");
        }
      },
      // The request shape is fixed here; no caller data is merged into it.
      // NOT YET VALIDATED against Learnosity's Author API reference: confirm
      // the item_edit config keys before this operation is enabled (Author
      // signing is contract-only until then; see the registry).
      run: async ({ reference, widgetTypes }, { key, secret }) => {
        const types = widgetTypes ?? [...AUTHOR_WIDGET_TYPES];
        const user = consumer(key);
        return {
          request: sdk.init("author", user, secret, {
            mode: "item_edit",
            reference,
            config: {
              dependencies: { questions_api: { init_options: { widgetTypes: types } } },
              item_edit: {
                item: { reference: { show: true, edit: false } },
                widget: { delete: true, edit: true },
              },
            },
            user: { id: user.user_id },
          }),
        };
      },
    },
    "learnosity.write-items": {
      kind: "write",
      validate: validateWrite,
      // Two provider writes: questions first (items reference them), then
      // items. Each step's status is reported so a failure after the first is
      // visible as `partial` rather than retried.
      run: async ({ questionRecords, itemRecords }, { key, secret }, { onStep }) => {
        const write = (route, body) =>
          dataApi({ route, request: sdk.init("data", { consumer_key: key, domain }, secret, body, "set") });
        await write("/itembank/questions", { questions: questionRecords });
        await onStep("questions");
        if (itemRecords.length > 0) {
          await write("/itembank/items", { items: itemRecords });
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
