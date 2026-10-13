// SPDX-License-Identifier: MIT
/**
 * The compiled record, and the one projection the renderer needs from it.
 *
 * This is where the view's logic lives, deliberately. There is no DOM in this package's test
 * suite — `vitest.config.ts` pulls in no jsdom — so anything that could be wrong without
 * looking wrong belongs in a pure function here, and the component stays a projection of it.
 */

/** One option in the set. The id is the service's own, or positional (`o0` upward). */
export interface Option {
  id: string;
  text: string;
}

/** What every compiled survey carries, whichever its style. */
interface SurveyBase {
  /** The survey taken. */
  id: string;
  /** One taking of it. */
  sessionId?: string;
  /** Which version of the survey this is — the file it came from. */
  instance?: string;
  title?: string;
  instructions: string;
}

/** Options to choose from and rank. Older records carry no `style`, and are this. */
export interface RankedSurvey extends SurveyBase {
  style?: "ranked-choice";
  options: Option[];
  minChoices: number;
  maxChoices: number;
}

/** One answerable point on a scale. */
export interface Point {
  value: number;
  label?: string;
}

/** Every scale form, compiled to one list of points. */
export interface Scale {
  name?: string;
  points: Point[];
  optOut?: string;
  display?: "stars";
}

/** One item of a rating survey, its scale resolved inline. */
export interface RatedItem {
  id: string;
  text: string;
  scale: Scale;
  required: boolean;
  /** The item's own words for the two ends of its scale. */
  anchors?: [string, string];
}

/** Items answered on a scale. */
export interface RatingSurvey extends SurveyBase {
  style: "rating";
  items: RatedItem[];
  comment?: { prompt?: string };
}

export type Survey = RankedSurvey | RatingSurvey;

export interface RankedResponse {
  /** Option ids, in priority order. The order IS the ranking. */
  choices: string[];
  /** One option that was not in the set. */
  writeIn?: string;
}

/** One answer: a value on the item's scale, or the opt-out. */
export type Rating = { item: string; value: number } | { item: string; optOut: true };

export interface RatingResponse {
  ratings: Rating[];
  comment?: string;
}

export interface Compiled {
  survey?: Survey;
  response?: RankedResponse | RatingResponse;
}

export const isRating = (survey: Survey): survey is RatingSurvey => survey.style === "rating";

export interface Resolved {
  /** The chosen options, in the order the response put them. */
  chosen: Option[];
  /**
   * Selected ids naming nothing in the set.
   *
   * The compiler refuses these, so a program that came through it cannot produce any. The view
   * renders a model, though, not a compilation — a record assembled by hand or by an older
   * build can arrive here — and silently dropping an id would show a shorter ranking than the
   * one that was actually recorded.
   */
  unknown: string[];
  /** Ids that appear in the selection, for dimming them where the set is shown. */
  chosenIds: Set<string>;
}

/** Resolve a response's ids against the set it answers. Pure; the component renders the result. */
export function resolveChoices(
  survey: RankedSurvey | undefined,
  response: RankedResponse | undefined,
): Resolved {
  const byId = new Map((survey?.options || []).map((i) => [i.id, i]));
  const chosen: Option[] = [];
  const unknown: string[] = [];

  for (const id of response?.choices || []) {
    const option = byId.get(id);
    if (option) chosen.push(option);
    else unknown.push(id);
  }

  return { chosen, unknown, chosenIds: new Set(chosen.map((i) => i.id)) };
}

/**
 * How the bounds read as a line of prose.
 *
 * Both bounds are always present in compiled output, so this states the range rather than
 * testing which of them was authored. The "any of N" case only arises when a survey explicitly
 * opens the whole set — the defaults (1, and 5 or one fewer than the set) never reach it.
 */
export function boundsLabel(survey: RankedSurvey): string {
  const n = survey.options.length;
  const { minChoices: min, maxChoices: max } = survey;
  if (min === max) return `Choose ${min} of ${n}`;
  if (min === 0 && max >= n) return `Choose any of ${n}`;
  if (min === 0) return `Choose up to ${max} of ${n}`;
  return `Choose ${min}–${max} of ${n}`;
}

/** One item of a rating survey, with the answer the response gave it, if any. */
export interface RatedRow {
  item: RatedItem;
  /** Absent when the item was not answered. */
  answer?: Rating;
}

export interface ResolvedRatings {
  /** Every item, in the survey's order. */
  rows: RatedRow[];
  /** How many items carry an answer. */
  answered: number;
  /**
   * Ratings naming no item in the survey, or a value its scale does not have.
   *
   * The compiler refuses both, so these only arrive on a record assembled outside it — and, as
   * with `choices`, dropping one silently would show fewer answers than were recorded.
   */
  unknown: Rating[];
}

/** Line a rating response up against the survey's items. Pure; the component renders the result. */
export function resolveRatings(
  survey: RatingSurvey,
  response: RatingResponse | undefined,
): ResolvedRatings {
  const byItem = new Map<string, Rating>();
  const unknown: Rating[] = [];
  const items = new Map(survey.items.map((x) => [x.id, x]));
  for (const r of response?.ratings || []) {
    const item = items.get(r.item);
    const onScale = !item
      ? false
      : "optOut" in r
        ? item.scale.optOut !== undefined
        : item.scale.points.some((p) => p.value === r.value);
    if (onScale) byItem.set(r.item, r);
    else unknown.push(r);
  }
  const rows = survey.items.map((item) => {
    const answer = byItem.get(item.id);
    return answer ? { item, answer } : { item };
  });
  return { rows, answered: byItem.size, unknown };
}

/**
 * The words at each end of an item's scale: the item's own anchors where it has them (a
 * semantic differential), otherwise its first and last points' labels.
 */
export function scaleEnds(item: RatedItem): [string | undefined, string | undefined] {
  if (item.anchors) return item.anchors;
  const { points } = item.scale;
  return [points[0]?.label, points[points.length - 1]?.label];
}

/** An answer as words: its point's label, its value where the point has none, or the opt-out. */
export function answerText(item: RatedItem, answer: Rating): string {
  if ("optOut" in answer) return item.scale.optOut ?? "Opted out";
  const point = item.scale.points.find((p) => p.value === answer.value);
  return point?.label ?? String(answer.value);
}
