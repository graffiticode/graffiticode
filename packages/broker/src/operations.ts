/* eslint-disable camelcase -- Learnosity wire fields are snake_case */
// Named operations. Each validates a CONSTRAINED payload and builds the
// provider request itself — none is a general signer or proxy. The broker
// supplies identity fields (consumer key, domain, user id); a payload can never
// set them.

import { createHash, randomUUID } from "node:crypto";
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
// questions and their dynamic data. No user, domain or security fields; `type`
// and `session_id` are accepted for compatibility but Broker sets both (see
// pinnedPreview).
const PREVIEW_KEYS = ["id", "name", "questions", "session_id", "dynamic_content_data", "type"];

// BROKER_PREVIEW_CONNECTIONS: JSON, backend -> the connection id of its
// preview consumer (AT-10 A3). Absent or empty means none, and
// Questions previews are refused; anything malformed stops the service.
export const parsePreviewConnections = (raw: string | undefined): Record<string, string> => {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("BROKER_PREVIEW_CONNECTIONS must be JSON");
  }
  if (!isPlainObject(parsed)) throw new Error("BROKER_PREVIEW_CONNECTIONS must be an object");
  for (const [backend, id] of Object.entries(parsed)) {
    if (backend !== "learnosity") throw new Error(`BROKER_PREVIEW_CONNECTIONS: ${backend} is not a known backend`);
    if (typeof id !== "string" || !id) throw new Error(`BROKER_PREVIEW_CONNECTIONS: ${backend} needs a connection id`);
  }
  return parsed;
};

// A preview never stores anything (AT-10, registry v8): Broker pins the
// activity type, and gives every signing its own session.
export const PREVIEW_TYPE = "local_practice";

const validatePreview = payload => {
  onlyKeys(payload, PREVIEW_KEYS, "preview");
  if (payload.type !== undefined && payload.type !== PREVIEW_TYPE) {
    throw new PayloadRejected(`preview.type must be "${PREVIEW_TYPE}" or absent`);
  }
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

// What a stored record says about an operation (format 1): whether it
// carries this operation's mark (`landed`: proof its write of the record
// happened, whatever came after), and whether its projected fields, without
// the mark, currently match what the operation sent (an observation of
// current state only; it resolves nothing).
const markOf = (kind, stored) => (kind === "question" ? stored?.data?.metadata?.[MARK_KEY] : stored?.metadata?.[MARK_KEY]);
const unmarked = (kind, stored) => {
  const strip = metadata => {
    const rest = withoutMark(metadata);
    return isPlainObject(rest) && Object.keys(rest).length === 0 ? undefined : rest;
  };
  if (kind === "question") {
    const data = isPlainObject(stored?.data) ? { ...stored.data, metadata: strip(stored.data.metadata) } : stored?.data;
    if (isPlainObject(data) && data.metadata === undefined) delete data.metadata;
    return { ...stored, data };
  }
  const item = { ...stored, metadata: strip(stored?.metadata) };
  if (item.metadata === undefined) delete item.metadata;
  return item;
};
export const observeRecord = ({ kind, digest }, stored, operationId) => {
  if (!stored) return { found: false, landed: false, matches: false };
  const fields = kind === "question" ? EVIDENCE_PROJECTION.questions : EVIDENCE_PROJECTION.items;
  return {
    found: true,
    landed: markOf(kind, stored) === operationId,
    matches: argsDigest(project(unmarked(kind, stored), fields)) === digest,
  };
};

// The records as Broker sends them: each carries this operation's mark.
const marked = ({ questionRecords, itemRecords }, operationId) => ({
  questionRecords: questionRecords.map(q => ({ ...q, data: { ...q.data, metadata: { ...withoutMark(q.data.metadata ?? {}), [MARK_KEY]: operationId } } })),
  itemRecords: itemRecords.map(it => ({ ...it, metadata: { ...withoutMark(it.metadata ?? {}), [MARK_KEY]: operationId } })),
});

// B1 (AT-10, registry v8): a save only ever creates records. Learnosity's
// Data API set creates or updates by reference, so Broker writes every record
// under a reference derived from the operation id, which no earlier save
// shares, and a save never changes a record already in the bank: `gc-<16 hex of sha256(opid)>-<reference
// as sent>`. The mapping depends only on the operation id and the payload, so
// a retry of the same operation reproduces it exactly. It is applied once,
// before the receipt claim, and its result is what Broker sends, records as
// evidence and returns; the args digest stays on the payload as sent.
export const REFERENCE_PREFIX = "gc-";
const REFERENCE_TAG_LENGTH = 16;
// The longest reference a program may send, so that the mapped one stays
// within Learnosity's 250 characters.
export const MAX_SENT_REFERENCE_LENGTH = 250 - REFERENCE_PREFIX.length - REFERENCE_TAG_LENGTH - 1;
export const referenceTag = (operationId: string) => createHash("sha256").update(operationId).digest("hex").slice(0, REFERENCE_TAG_LENGTH);
export const providerReferences = (payload, operationId) => {
  if (typeof operationId !== "string" || !operationId) throw new Error("mapping references needs the operation id");
  const tag = referenceTag(operationId);
  const map = reference => `${REFERENCE_PREFIX}${tag}-${reference}`;
  const link = w => ({ ...w, reference: map(w.reference) });
  return {
    questionRecords: payload.questionRecords.map(q => ({ ...q, reference: map(q.reference) })),
    itemRecords: payload.itemRecords.map(it => ({
      ...it,
      reference: map(it.reference),
      ...(it.definition ? { definition: { ...it.definition, widgets: it.definition.widgets.map(link) } } : {}),
      ...(it.questions ? { questions: it.questions.map(link) } : {}),
    })),
  };
};

// An item's links to questions: `definition.widgets` and `questions`, each a
// list of { reference }. Every link names a question this same save writes, so
// the mapping can follow it; an item can't point at a record outside the save.
const validateLinks = (it, i, written) => {
  const lists = [];
  if (it.definition !== undefined) {
    onlyKeys(it.definition, ["widgets"], `write.itemRecords[${i}].definition`);
    lists.push(["definition.widgets", it.definition.widgets]);
  }
  if (it.questions !== undefined) lists.push(["questions", it.questions]);
  for (const [where, links] of lists) {
    if (!Array.isArray(links)) throw new PayloadRejected(`write.itemRecords[${i}].${where} must be a list`);
    links.forEach((w, j) => {
      onlyKeys(w, ["reference"], `write.itemRecords[${i}].${where}[${j}]`);
      if (!written.has(w.reference)) {
        throw new PayloadRejected(`write.itemRecords[${i}].${where}[${j}] must reference a question this save writes`);
      }
    });
  }
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
    if (q.reference.length > MAX_SENT_REFERENCE_LENGTH) {
      throw new PayloadRejected(`write.questionRecords[${i}].reference is longer than ${MAX_SENT_REFERENCE_LENGTH} characters`);
    }
    if (q.data.metadata !== undefined && !isPlainObject(q.data.metadata)) {
      throw new PayloadRejected(`write.questionRecords[${i}].data.metadata must be an object`);
    }
    if (isPlainObject(q.data.metadata) && Object.prototype.hasOwnProperty.call(q.data.metadata, MARK_KEY)) {
      throw new PayloadRejected(`write.questionRecords[${i}].data.metadata.${MARK_KEY} is set by Broker, never by a program`);
    }
  });
  const written = new Set(questionRecords.map(q => q.reference));
  itemRecords.forEach((it, i) => {
    if (!isPlainObject(it) || !isRef(it.reference)) {
      throw new PayloadRejected(`write.itemRecords[${i}] needs a reference`);
    }
    if (it.reference.length > MAX_SENT_REFERENCE_LENGTH) {
      throw new PayloadRejected(`write.itemRecords[${i}].reference is longer than ${MAX_SENT_REFERENCE_LENGTH} characters`);
    }
    validateLinks(it, i, written);
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

// A preview signature's acceptance window (PROVIDER-01, AT-10). Without
// `expires` Learnosity accepts a signature for 7 days, and an established
// session can save or submit for as long; the Questions API doesn't sign the
// request, so a holder can change its type and store responses. `expires` is
// in the signature, so it can't be extended, and after it every save or submit
// fails. Minutes, 1 to 60 (BROKER_PREVIEW_EXPIRES_MINUTES).
export const DEFAULT_PREVIEW_EXPIRES_MINUTES = 10;

// Learnosity's security-packet time, UTC to the minute (YYYYMMDD-HHmm).
export const learnosityTime = (date: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}`;
};

export const buildOperations = ({ sdk, domain, dataApi, previewExpiresMinutes = DEFAULT_PREVIEW_EXPIRES_MINUTES, now = () => new Date() }) => {
  if (!Number.isInteger(previewExpiresMinutes) || previewExpiresMinutes < 1 || previewExpiresMinutes > 60) {
    throw new Error("previewExpiresMinutes must be a whole number of minutes, 1 to 60");
  }
  const consumer = key => ({ consumer_key: key, domain, user_id: randomUUID() });
  // Previews only: Data API requests keep their own timestamp check.
  const previewConsumer = key => ({ ...consumer(key), expires: learnosityTime(new Date(now().getTime() + previewExpiresMinutes * 60_000)) });
  // The request as signed: the payload's content, with Broker's type and a
  // session of its own. The Items API signs these; the Questions API doesn't,
  // which is why its previews sign only with the preview consumer
  // (broker.js, `signsWith: "preview-consumer"`).
  const pinnedPreview = payload => ({ ...payload, type: PREVIEW_TYPE, session_id: randomUUID() });
  return {
    // The Questions API's signature covers the security packet, not the
    // request, so whoever holds it can change the request. Broker signs it
    // only with the preview consumer, never a connection's own (AT-10 A3,
    // registry v8): Graffiticode's own, used for nothing but previews. Its
    // signature is refused by every other service, and its sessions make no
    // item-bank call (both measured).
    "learnosity.sign-questions-preview": {
      kind: "sign",
      signsWith: "preview-consumer",
      validate: validatePreview,
      run: async (payload, { key, secret }) => ({ request: sdk.init("questions", previewConsumer(key), secret, pinnedPreview(payload)) }),
    },
    // The Items API signs the request, so the pinned fields hold; it renders
    // the owner's published items, so it signs with the connection's consumer.
    "learnosity.sign-items-preview": {
      kind: "sign",
      signsWith: "connection",
      validate: validatePreview,
      run: async (payload, { key, secret }) => ({ request: sdk.init("items", previewConsumer(key), secret, pinnedPreview(payload)) }),
    },
    "learnosity.write-items": {
      kind: "write",
      validate: validateWrite,
      // B1: the records as written, under references no earlier save shares.
      // Broker applies it once, before the claim, and passes the result to
      // `evidence` and `run`.
      references: providerReferences,
      evidence: writeEvidence,
      // Reconciliation's read (WRITE-02): the stored records for exactly the
      // references the claim's evidence names, never anything else. Reads
      // only; returns { question: Map, item: Map } by reference.
      readBack: async (evidence, { key, secret }, { timeoutMs }) => {
        const refs = kind => evidence.records.filter(r => r.kind === kind).map(r => r.reference);
        const get = async (route, references) => {
          if (!references.length) return new Map();
          const res = await dataApi({ route, request: sdk.init("data", { consumer_key: key, domain }, secret, { references, limit: references.length }, "get"), timeoutMs });
          const rows = Array.isArray(res?.data) ? res.data : [];
          return new Map(rows.filter(r => references.includes(r?.reference)).map(r => [r.reference, r]));
        };
        return { question: await get("/itembank/questions", refs("question")), item: await get("/itembank/items", refs("item")) };
      },
      // Two provider writes: questions first (items reference them), then
      // items. Each step's status is reported so a failure after the first is
      // visible as `partial` rather than retried. `providerCall` (from the
      // broker) authorizes each request and refuses to start one past the
      // operation's deadline, then gives it its timeout.
      run: async (payload, { key, secret }, { onStep, providerCall, operationId }) => {
        if (typeof operationId !== "string" || !operationId) throw new Error("a write needs its operation id, for the mark");
        // Only records already mapped for this operation (B1) are written: a
        // payload that reached here unmapped is a bug, refused before any
        // provider request.
        const ours = `${REFERENCE_PREFIX}${referenceTag(operationId)}-`;
        const refs = [...payload.questionRecords, ...payload.itemRecords].map(r => r.reference);
        if (!refs.every(r => typeof r === "string" && r.startsWith(ours))) throw new Error("a write's records must carry its operation's references");
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
