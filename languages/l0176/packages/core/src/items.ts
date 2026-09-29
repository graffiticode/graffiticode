// SPDX-License-Identifier: MIT
// Ported from L0158 packages/api/src/items.js. Credentials (key/secret) are
// supplied per call (injected via config in compiler.ts); the non-secret
// `domain` is baked at construction.
import { v4 as uuid } from "uuid";

// Translate a DSL item-level metadata list into the Learnosity item record's
// faceted `tags`, `metadata` bag, and top-level scalar fields (`note`,
// `description`, `source`, `adaptive.difficulty`).
//
// Input is an array of tagged entries produced by the arity-1 member
// constructors in the DSL: `{ kind, value }` where kind is one of
// "tags" | "notes" | "acknowledgements" |
// "description" | "source" | "difficulty_level".
//
// Faceted conventions like Difficulty, DOK, and standards have no
// dedicated Learnosity fields — authors put them in the `tags` record
// (e.g. `tags { Difficulty: "medium", DOK: 2 }`) and the Author Site
// filter rail surfaces them automatically.
//
// Item details page fields bind to specific Learnosity locations:
//   notes            → item.note (top-level, singular)
//   description      → item.description (top-level)
//   source           → item.source (top-level)
//   difficulty-level → item.adaptive.difficulty (integer Rasch calibration)
//   acknowledgements → item.metadata.acknowledgements (nested bag)
//
// Tag type names follow Learnosity's sample-data convention: title-case for
// words ("Difficulty") and caps for acronyms. Tag values are strings
// (integers are stringified). `tags` entries accept a record whose values are
// a string or an array of strings — a bare string is treated as a single-
// element array for authoring convenience.
export function translateItemMetadata(metadata: any) {
  const empty = {
    tags: undefined,
    note: undefined,
    description: undefined,
    source: undefined,
    adaptive: undefined,
    metadata: undefined,
  };
  if (metadata == null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return empty;
  }
  const tags: any = {};
  for (const [type, raw] of Object.entries(metadata.tags ?? {})) {
    if (raw == null) continue;
    tags[type] = (Array.isArray(raw) ? raw : [raw]).map(String);
  }
  const meta: any = {};
  if (metadata.acknowledgements !== undefined) meta.acknowledgements = metadata.acknowledgements;
  return {
    tags: Object.keys(tags).length > 0 ? tags : undefined,
    note: metadata.notes,
    description: metadata.description,
    source: metadata.source,
    adaptive: metadata.difficulty_level !== undefined
      ? { difficulty: metadata.difficulty_level }
      : undefined,
    metadata: Object.keys(meta).length > 0 ? meta : undefined,
  };
}

const getDynamicContentData = (data: any) => {
  if (!data) {
    return;
  }
  const reference = "graffiticode-" + new Date().toISOString().split(":").join("").split(".").join("");
  let cols: any;
  const rows: any = {};
  if (data) {
    data.forEach((d: any, i: number) => {
      if (!cols) {
        cols = Object.keys(d);
      }
      const vals = Object.values(d);
      rows[reference + "-row-" + i] = {
        "values": vals,
        "index": i,
      };
    });
  }
  return {
    cols: cols,
    rows: rows,
  };
};

// Builds the render activity and, beside it, the plan an item-bank save would
// write. Building never writes: the write is `save-to-itembank`'s alone, and
// happens only in the broker, so no evaluation of `items` can reach the Data
// API.
export const buildCreateItems = () => async ({
  items,
  params,
  id,
}: any) => {
  const batchId = id || "0";

  // Inherited (from an embedded L0179 custom question) overrides declared. When
  // a widget is embedded, its expansion is authoritative. `params` is declared
  // once for the whole list, because Learnosity attaches one dynamic-content
  // table per rendered activity.
  const inherited = items
    .map((it: any) => it.templateVariablesRecords)
    .find((r: any) => Array.isArray(r) && r.length > 0);
  const dynamicContentData = getDynamicContentData(inherited || params);

  // One record per item. References carry the item's ordinal so that several
  // items in one program do not collide — and so do the question references
  // beneath them, which are only unique within their own item as built.
  const records = items.map((item: any, index: number) => {
    const itemRef = `graffiticode-${batchId}-${index}`;
    // `createQuestions` hands back questions in the render shape, keyed by
    // `response_id`. Re-key them so the item ordinal is in the id: within one
    // item the ids are unique, but two items each leading with an mcq would
    // both produce `…-mcq-t-0` without it.
    const questions = item.data.questions.map((q: any, qIndex: number) => ({
      ...q,
      response_id: `artcompiler-${q.type}-${batchId}-${index}-${qIndex}`,
    }));
    const widgets = questions.map((q: any) => ({ reference: q.response_id }));
    const { tags, note, description, source, adaptive, metadata } =
      translateItemMetadata(item.metadata);
    const record: any = {
      reference: itemRef,
      definition: { widgets },
      dynamic_content_data: dynamicContentData,
      questions: widgets,
    };
    if (tags !== undefined) record.tags = tags;
    if (note !== undefined) record.note = note;
    if (description !== undefined) record.description = description;
    if (source !== undefined) record.source = source;
    if (adaptive !== undefined) record.adaptive = adaptive;
    if (metadata !== undefined) record.metadata = metadata;
    return { record, questions };
  });

  // What a save would write. An item record only *references* its widgets; it
  // does not carry them, so the questions must exist in the bank before the
  // item that points at them, or Learnosity rejects the item with
  //   30001 Widget (question / feature) reference ... was not found.
  // The bank stores a question as {type, reference, data}; `response_id` is
  // the render envelope's key for the same question and is not part of the
  // stored data, so it becomes the reference and is dropped from the payload.
  // Saved items always land as drafts; publishing is an Author Site concern.
  const savePlan = {
    questionRecords: records.flatMap(({ questions }: any) =>
      questions.map(({ response_id, ...data }: any) => ({
        type: data.type,
        reference: response_id,
        data,
      })),
    ),
    itemRecords: records.map(({ record }: any) => ({ ...record, status: "unpublished" })),
  };

  // Rendering always goes through Questions API with inline question data, so
  // every item's questions flatten into one list. The item bank write (above)
  // is for listing/search only — it doesn't affect the preview, and Items API
  // can't render unpublished items anyway. When item-level features (shared
  // stimulus, layout) land, published items will need to route through Items
  // API from the bank to preserve both the grouping and the fidelity.
  const inlineQuestions = records.flatMap(({ questions }: any) => questions);
  const data: any = {
    id: `${batchId}`,
    name: "Test",
    questions: inlineQuestions,
    session_id: uuid(),
  };
  if (dynamicContentData) data.dynamic_content_data = dynamicContentData;
  return { activity: { type: "questions", data }, savePlan };
};

export const buildInitItems = ({
  sdk,
  key,
  secret,
  domain,
}: any) => async ({ data }: any, { key: optKey, secret: optSecret }: any = {}) => {
  // Construct a items api request.
  const user_id = uuid();
  const consumer = {
    consumer_key: optKey ?? key,
    domain,
    user_id,
  };
  const signedRequest = sdk.init(
    "items",
    consumer,
    optSecret ?? secret,
    data,
  );
  return signedRequest;
};
