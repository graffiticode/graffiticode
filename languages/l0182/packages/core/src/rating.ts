// SPDX-License-Identifier: MIT
/**
 * The rating style: a list of items — statements, questions — each answered on a scale. It covers
 * the Likert family in one shape: an agreement grid, a satisfaction or frequency question, an
 * NPS question, star ratings, a semantic differential. What varies between them is the scale, and
 * `scales.ts` reduces every scale to one list of points, so nothing here knows which form it has.
 *
 * As with ranked choice, the survey is data and never code: the items, their scales, which are
 * required and whether a comment is asked for all come from the survey's file. A program only
 * answers — `ratings [[item "…" rating "Agree"] …]` and at most one `comment`.
 */
import { assertKnownAttributes, mergeAttributes } from "./attributes.js";
import { indexOf, normaliseText, resolveRef, showValue } from "./resolve.js";
import { readAnchors, readScale, Scale } from "./scales.js";

/** One item as compiled: its scale resolved inline, so a reader needs nothing else. */
export interface RatedItem {
  id: string;
  text: string;
  scale: Scale;
  /** Must a response answer it? An opt-out counts as an answer. */
  required: boolean;
  /** This item's words for the two ends of its scale — a semantic differential. */
  anchors?: [string, string];
}

/** The rating half of a compiled survey. `survey.ts` adds id, session and instance. */
export interface RatingFields {
  style: "rating";
  title?: string;
  instructions: string;
  items: RatedItem[];
  /** Present when the survey asks for a free-text comment; `prompt` is the question it asks. */
  comment?: { prompt?: string };
}

/** One answer as compiled: a value on the item's scale, or the opt-out. */
export type Rating = { item: string; value: number } | { item: string; optOut: true };

export interface RatingResponse {
  /** In the survey's item order, whatever order they were written in. */
  ratings: Rating[];
  comment?: string;
}

/** A rating response as written: each entry's `item` and `rating` still in whatever notation. */
export interface AuthoredRating {
  ratings: Array<{ item: string | number; rating: string | number }>;
  comment?: string;
}

/** The wording a rating survey falls back to when its data says nothing. */
export const DEFAULT_RATING_INSTRUCTIONS =
  "Please answer each of the following on the scale beside it.";

/** Find the scale an item or the survey names: its own `scales` first, then the presets. */
function scaleFor(where: string, raw: any, named: Map<string, Scale>): Scale {
  if (typeof raw === "string" && named.has(raw)) {
    const s = named.get(raw)!;
    return { ...s, points: s.points.map((p) => ({ ...p })) };
  }
  return readScale(where, raw);
}

/** Check and assemble a rating survey from its data. Every message names the file. */
export function assembleRating(instance: string, data: any): RatingFields {
  const named = new Map<string, Scale>();
  if (data.scales !== undefined) {
    if (data.scales === null || typeof data.scales !== "object" || Array.isArray(data.scales)) {
      throw new Error(
        `survey: ${instance} has \`scales\` that are ${showValue(data.scales)}; \`scales\` is a record of named scales.`,
      );
    }
    for (const [name, raw] of Object.entries(data.scales)) {
      named.set(name, readScale(`survey: ${instance}, scale ${JSON.stringify(name)}`, raw, name));
    }
  }

  const fallback =
    data.scale !== undefined
      ? scaleFor(`survey: ${instance}, \`scale\``, data.scale, named)
      : undefined;

  if (!Array.isArray(data.items) || !data.items.length) {
    throw new Error(
      `survey: ${instance} holds no items. A rating survey's data has an \`items\` list — each a ` +
        'line of text, or a record like {"id": "q1", "text": "…", "scale": "agreement-5"}.',
    );
  }

  const items: RatedItem[] = data.items.map((entry: any, i: number) => {
    const where = `survey: ${instance}, item ${i + 1}`;
    const rec = typeof entry === "string" ? { text: entry } : entry;
    if (rec === null || typeof rec !== "object" || Array.isArray(rec)) {
      throw new Error(
        `${where} is ${showValue(entry)}. An item is a line of text, or a record with its \`text\`.`,
      );
    }
    if (typeof rec.text !== "string" || !rec.text.trim()) {
      throw new Error(`${where} has no \`text\`, the statement or question to rate.`);
    }
    if (rec.id !== undefined && (typeof rec.id !== "string" || !rec.id.trim())) {
      throw new Error(`${where} has an \`id\` that is ${showValue(rec.id)}; ids are strings.`);
    }
    if (rec.required !== undefined && typeof rec.required !== "boolean") {
      throw new Error(
        `${where} has a \`required\` of ${showValue(rec.required)}; it is true or false.`,
      );
    }
    let scale: Scale;
    if (rec.scale !== undefined) scale = scaleFor(`${where}, \`scale\``, rec.scale, named);
    else if (fallback) scale = { ...fallback, points: fallback.points.map((p) => ({ ...p })) };
    else {
      throw new Error(
        `${where} has no \`scale\`, and the survey sets no default \`scale\` for it to fall back on.`,
      );
    }
    const anchors = readAnchors(where, rec.anchors);
    return {
      id: typeof rec.id === "string" ? rec.id : `q${i}`,
      text: rec.text.trim(),
      scale,
      required: rec.required !== false,
      ...(anchors ? { anchors } : {}),
    };
  });

  const byText = new Map<string, number>();
  const byId = new Map<string, number>();
  items.forEach((item, i) => {
    if (byText.has(item.text)) {
      throw new Error(
        `survey: ${instance} has items ${byText.get(item.text)! + 1} and ${i + 1} both ${JSON.stringify(item.text)}. ` +
          "Each item must be distinct — a duplicate asks the same thing twice.",
      );
    }
    byText.set(item.text, i);
    if (byId.has(item.id)) {
      throw new Error(
        `survey: ${instance} has items ${byId.get(item.id)! + 1} and ${i + 1} sharing the id ${JSON.stringify(item.id)}, ` +
          "so a rating naming it is ambiguous. Give each item its own id, or drop the ids and let them be numbered by position.",
      );
    }
    byId.set(item.id, i);
  });

  let comment: { prompt?: string } | undefined;
  if (data.comment === true) comment = {};
  else if (data.comment !== undefined && data.comment !== false) {
    const prompt = data.comment?.prompt;
    if (
      data.comment === null ||
      typeof data.comment !== "object" ||
      (prompt !== undefined && (typeof prompt !== "string" || !prompt.trim()))
    ) {
      throw new Error(
        `survey: ${instance} has a \`comment\` of ${showValue(data.comment)}. It is true, or a record with the \`prompt\` to ask.`,
      );
    }
    comment = prompt !== undefined ? { prompt: prompt.trim() } : {};
  }

  return {
    style: "rating",
    ...(data.title !== undefined ? { title: data.title } : {}),
    instructions: data.instructions !== undefined ? data.instructions : DEFAULT_RATING_INSTRUCTIONS,
    items,
    ...(comment ? { comment } : {}),
  };
}

/**
 * Read `ratings [[item … rating …] …]` into plain entries.
 *
 * Each entry is its own attribute list, merged and checked here — `item` and `rating` are the only
 * words it takes, and both are needed, because a rating that does not say what it rates, or an
 * item with no rating, records nothing.
 */
export function readRatings(raw: any[]): AuthoredRating["ratings"] {
  return raw.map((entry, i) => {
    const where = `ratings: entry ${i + 1}`;
    const attrs = mergeAttributes(entry, where);
    assertKnownAttributes("ratings", attrs);
    if (attrs.item === undefined || attrs.rating === undefined) {
      const missing = attrs.item === undefined ? "item" : "rating";
      throw new Error(
        `${where} has no \`${missing}\`. Each rating names the item and its answer: ` +
          '[item "The course met its goals" rating "Agree"].',
      );
    }
    return { item: attrs.item, rating: attrs.rating };
  });
}

/** What an item's scale accepts, in words, for a message about an answer it did not. */
function accepts(item: RatedItem): string {
  const { points, optOut } = item.scale;
  const lo = points[0].value;
  const hi = points[points.length - 1].value;
  const labels = points.filter((p) => p.label).map((p) => `${p.value} ${JSON.stringify(p.label)}`);
  const ends = item.anchors
    ? `, or its ends ${JSON.stringify(item.anchors[0])} (${lo}) and ${JSON.stringify(item.anchors[1])} (${hi})`
    : "";
  const byLabel =
    labels.length === points.length
      ? `, or by label: ${labels.join(", ")}`
      : labels.length
        ? ` (${labels.join(", ")})`
        : "";
  const out = optOut ? `; or ${JSON.stringify(optOut)} to opt out` : "";
  return `a value from ${lo} to ${hi}${byLabel}${ends}${out}`;
}

/**
 * Resolve one answer against its item's scale.
 *
 * A number is the scale's own VALUE — NPS 9 is 9, a 1–5 agreement 4 is "Agree" — and never a
 * position, which is the opposite of what a number means in `choices` and deliberately so: on a
 * scale the number IS the answer. A string is a point's label, the item's anchor for an end, the
 * opt-out, or a number written in quotes. Labels match the way option text does: case, surrounding
 * space and runs of whitespace are forgiven, the words are not.
 */
function resolveAnswer(answer: string | number, item: RatedItem, where: string): Rating {
  const { points, optOut } = item.scale;
  const byValue = (v: number) => points.find((p) => p.value === v);

  if (typeof answer === "number") {
    if (byValue(answer)) return { item: item.id, value: answer };
    throw new Error(
      `${where} rates ${JSON.stringify(item.text)} ${answer}, which is not on its scale. It takes ${accepts(item)}.`,
    );
  }

  const key = normaliseText(answer);
  const label = points.find((p) => p.label !== undefined && normaliseText(p.label) === key);
  if (label) return { item: item.id, value: label.value };
  if (item.anchors) {
    if (normaliseText(item.anchors[0]) === key) return { item: item.id, value: points[0].value };
    if (normaliseText(item.anchors[1]) === key) {
      return { item: item.id, value: points[points.length - 1].value };
    }
  }
  if (optOut !== undefined && normaliseText(optOut) === key) return { item: item.id, optOut: true };
  if (/^-?\d+$/.test(key) && byValue(Number(key))) return { item: item.id, value: Number(key) };

  throw new Error(
    `${where} rates ${JSON.stringify(item.text)} ${JSON.stringify(answer)}, which is not an answer on its scale. ` +
      `It takes ${accepts(item)}.`,
  );
}

/**
 * Check a rating response against the survey it answers, and resolve it to item ids and values.
 *
 * Every rating names an item the survey holds, no item is rated twice, every answer is on its
 * item's scale, and every required item is answered. A comment is refused where the survey asked
 * for none — there is nowhere for it to go.
 */
export function resolveRatingResponse(
  authored: AuthoredRating,
  survey: RatingFields,
): RatingResponse {
  const index = indexOf(survey.items);
  const answered = new Map<string, Rating>();

  authored.ratings.forEach(({ item: ref, rating }, i) => {
    const where = `response: \`ratings\` entry ${i + 1}`;
    const item = resolveRef(ref, `${where}'s \`item\``, index, "item");
    if (answered.has(item.id)) {
      throw new Error(
        `response: \`ratings\` rates ${JSON.stringify(item.text)} twice. Each item takes one answer — keep the one you mean.`,
      );
    }
    answered.set(item.id, resolveAnswer(rating, item, where));
  });

  const missing = survey.items.filter((x) => x.required && !answered.has(x.id));
  if (missing.length) {
    throw new Error(
      `response: \`ratings\` leaves out ${missing.length} required ${missing.length === 1 ? "item" : "items"}: ` +
        `${missing.map((x) => JSON.stringify(x.text)).join(", ")}. Rate ${missing.length === 1 ? "it" : "each one"}` +
        (missing.some((x) => x.scale.optOut)
          ? ", or answer with the scale's opt-out where it has one."
          : "."),
    );
  }

  const { comment } = authored;
  if (comment !== undefined && !survey.comment) {
    throw new Error(
      "response: `comment` is not asked for by this survey, so there is nowhere to record it. Leave `comment` out.",
    );
  }

  return {
    ratings: survey.items.filter((x) => answered.has(x.id)).map((x) => answered.get(x.id)!),
    ...(comment !== undefined ? { comment } : {}),
  };
}
