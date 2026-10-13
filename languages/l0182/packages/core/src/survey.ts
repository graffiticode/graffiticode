// SPDX-License-Identifier: MIT
/**
 * The survey record, and the rules that hold a response to it.
 *
 * A survey is named by a program and read from its data; it comes in one of two STYLES, which the
 * data declares:
 *
 * - **ranked-choice** (`ranked.ts`) — a set of options; a response chooses some, puts them in
 *   priority order, and may add one write-in.
 * - **rating** (`rating.ts`) — a list of items, each answered on a scale: Likert, NPS, stars,
 *   semantic differential. A response rates the items and may add a comment.
 *
 * There is no flow here and no player anywhere in this repo; the code IS the interface, written by
 * a person in the console's editor or by an agent through `update_item`, and the view only
 * renders what the code says.
 *
 * Because there is no player, nothing at delivery time can hold a response inside the survey's
 * bounds. **The compiler is the only enforcement there is**, which is why the rules are more
 * thorough than a form-backed language would need, and why every message names the fix rather
 * than merely reporting the fault: the reader is a code-generating model that will read it and
 * retry.
 *
 * All validation runs in the TRANSFORMER. `Checker.LIST` visits only `elts[0]`, so a rule
 * written as a Checker method would fire on the first attribute and nowhere else.
 */
import { assertKnownAttributes, mergeAttributes } from "./attributes.js";
import {
  assembleRanked,
  AuthoredRanked,
  RankedFields,
  RankedResponse,
  resolveRankedResponse,
} from "./ranked.js";
import {
  assembleRating,
  AuthoredRating,
  RatingFields,
  RatingResponse,
  readRatings,
  resolveRatingResponse,
} from "./rating.js";
import { showValue } from "./resolve.js";
import { LoadedSurvey } from "./source.js";

export { DEFAULT_INSTRUCTIONS } from "./ranked.js";
export { DEFAULT_RATING_INSTRUCTIONS } from "./rating.js";

export const STYLES = ["ranked-choice", "rating"] as const;
export type Style = (typeof STYLES)[number];

/** What every compiled survey carries, whichever its style. */
interface SurveyBase {
  /** The survey taken. The id as written, so `civic-priorities-7` stays itself. */
  id: string;
  /** One taking of it, absent when the program did not say. */
  sessionId?: string;
  /** Which version of the survey was taken — the file it came from. */
  instance: string;
}

export type Survey = SurveyBase & (RankedFields | RatingFields);

/** What the compiler emits. `response` is absent until something answers. */
export interface Compiled {
  survey: Survey;
  response?: RankedResponse | RatingResponse;
}

/** A response as written, before the survey's style says which half of it applies. */
export interface AuthoredResponse {
  choices?: AuthoredRanked["choices"];
  writeIn?: string;
  ratings?: AuthoredRating["ratings"];
  comment?: string;
}

/**
 * Which style a survey's data declares.
 *
 * Required rather than inferred: a rating survey that lost its `style` would otherwise fail as a
 * ranked-choice survey with no options, which points at the wrong fault. A bare list is the one
 * shorthand — a list of options and nothing else — and can only be ranked choice.
 */
function styleOf(instance: string, data: any): Style {
  if (Array.isArray(data)) return "ranked-choice";
  if (data === null || typeof data !== "object") {
    throw new Error(
      `survey: ${instance} is ${showValue(data)}. A survey's data is a record with its \`style\`, title, instructions and contents.`,
    );
  }
  if (!STYLES.includes(data.style)) {
    throw new Error(
      `survey: ${instance} ${data.style === undefined ? "does not say its `style`" : `has the style ${showValue(data.style)}`}. ` +
        'Give "style": "ranked-choice" (options to choose and rank) or "style": "rating" (items answered on a scale).',
    );
  }
  return data.style;
}

/** Trim a free-text answer, refusing an empty one rather than recording a blank. */
function freeText(word: string, raw: any, what: string): string | undefined {
  if (raw === undefined) return undefined;
  const text = String(raw).trim();
  if (!text) {
    throw new Error(
      `response: \`${word}\` is empty. Write ${what}, or leave \`${word}\` out — an empty one says nothing.`,
    );
  }
  return text;
}

/** Assemble a response from its attribute list. Checked against the survey by `buildSurvey`. */
export function buildResponse(raw: any): AuthoredResponse {
  const attrs = mergeAttributes(raw, "response");
  assertKnownAttributes("response", attrs);

  if (
    attrs.choices === undefined &&
    attrs.writeIn === undefined &&
    attrs.ratings === undefined &&
    attrs.comment === undefined
  ) {
    throw new Error(
      "response: is empty. Answer a ranked-choice survey with the options chosen and, optionally, a " +
        'write-in — response [choices ["…" "…"] write-in "…"] — or a rating survey with its ' +
        'ratings — response [ratings [[item "…" rating "…"]]].',
    );
  }

  const writeIn = freeText("write-in", attrs.writeIn, "the new option");
  const comment = freeText("comment", attrs.comment, "the comment");

  return {
    ...(attrs.choices !== undefined ? { choices: attrs.choices } : {}),
    ...(writeIn !== undefined ? { writeIn } : {}),
    ...(attrs.ratings !== undefined ? { ratings: readRatings(attrs.ratings) } : {}),
    ...(comment !== undefined ? { comment } : {}),
  };
}

/**
 * The attribute list of a `survey`, read far enough to know what to load.
 *
 * Reading `id` and `session-id` has to happen BEFORE the survey's data can be asked for, and
 * loading it is asynchronous, so the two halves are separate: this one, and `buildSurvey`.
 */
export function readSurveyAttributes(raw: any): {
  id: string;
  sessionId?: string;
  attrs: Record<string, any>;
} {
  const attrs = mergeAttributes(raw, "survey");
  assertKnownAttributes("survey", attrs);

  if (attrs.id === undefined) {
    throw new Error(
      'survey: needs `id`, the survey being taken, e.g. survey [id "civic-priorities" session-id ' +
        'get-val-public "itemId"]. What the survey asks comes from the survey itself, so the id is ' +
        "what says which survey this is.",
    );
  }

  // An empty session id is what an unresolved `get-val-public "itemId"` leaves behind, and it is
  // no session at all: treating it as one would hand every such compile the same survey.
  const sessionId =
    typeof attrs.sessionId === "string" && attrs.sessionId.trim()
      ? attrs.sessionId.trim()
      : undefined;

  return { id: attrs.id, sessionId, attrs };
}

/** Refuse the words of one style written in answer to the other, naming the words that fit. */
function assertStyleWords(style: Style, survey: SurveyBase, r: AuthoredResponse): void {
  const wrong =
    style === "rating"
      ? (["choices", "write-in"] as const).filter((w) =>
          w === "choices" ? r.choices !== undefined : r.writeIn !== undefined,
        )
      : (["ratings", "comment"] as const).filter((w) =>
          w === "ratings" ? r.ratings !== undefined : r.comment !== undefined,
        );
  if (!wrong.length) return;
  const words = wrong.map((w) => `\`${w}\``).join(" and ");
  throw new Error(
    style === "rating"
      ? `response: ${words} ${wrong.length === 1 ? "answers" : "answer"} a ranked-choice survey, but ${survey.instance} is a rating survey. ` +
          'Answer it with ratings [[item "…" rating "…"] …], naming each item by its text, and a `comment` if the survey asks for one.'
      : `response: ${words} ${wrong.length === 1 ? "answers" : "answer"} a rating survey, but ${survey.instance} is a ranked-choice survey. ` +
          'Answer it with choices ["…" "…"], naming each option by its text, and optionally one `write-in`.',
  );
}

/**
 * Assemble the compiled survey from its attribute list and the survey data that was loaded for
 * it.
 *
 * What the survey asks — options or items, the wording, the bounds, the scales — is the
 * SURVEY's; it comes from the loaded file, not from the program, which says only which survey is
 * being taken. What the program contributes is the response.
 *
 * `response` is lifted out of the survey's list to the top level of the emitted record. It is
 * written inside the brackets because `PROG` takes the program's LAST expression, so a second
 * top-level expression would silently discard the first — but it is not part of the survey, it
 * is an answer to one, and the two must be separable by anything reading the output.
 */
export function buildSurvey(raw: any, loaded: LoadedSurvey): Compiled {
  const { id, sessionId, attrs } = readSurveyAttributes(raw);
  const { instance, data } = loaded;
  const base: SurveyBase = { id, ...(sessionId !== undefined ? { sessionId } : {}), instance };
  const style = styleOf(instance, data);
  const authored = attrs.response as AuthoredResponse | undefined;

  if (style === "rating") {
    const survey = { ...base, ...assembleRating(instance, data) };
    if (!authored) return { survey };
    assertStyleWords(style, base, authored);
    const response = resolveRatingResponse(
      {
        ratings: authored.ratings ?? [],
        ...(authored.comment !== undefined ? { comment: authored.comment } : {}),
      },
      survey,
    );
    return { survey, response };
  }

  const survey = { ...base, ...assembleRanked(instance, data) };
  if (!authored) return { survey };
  assertStyleWords(style, base, authored);
  const response = resolveRankedResponse(
    {
      choices: authored.choices ?? [],
      ...(authored.writeIn !== undefined ? { writeIn: authored.writeIn } : {}),
    },
    survey,
  );
  return { survey, response };
}
