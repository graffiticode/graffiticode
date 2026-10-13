// SPDX-License-Identifier: MIT
/**
 * The activity layer: an ordered list of items, plus the delivery configuration that governs
 * how a candidate moves through them.
 *
 * Back-ported from L0182, which built it first. L0176 (Learnosity) already establishes the
 * family's shape — an activity IS a list of items — and QTI supplies the delivery vocabulary,
 * `navigationMode` and `submissionMode`. Nothing in this file knows what an assessment is,
 * deliberately: keeping it free of L0180's own concepts is what let it move here unchanged, and
 * what will let it move again.
 *
 * What an activity adds over a bare item is the level ABOVE it. `item` already groups several
 * interactions over one stimulus and scores them together; an activity groups several of THOSE,
 * scored independently, which is what a quiz or a test actually is.
 *
 * Sections (QTI's `assessmentSection`) are not here yet, and this is where they belong when they
 * come: a section carries a rule over a GROUP of items — drawing 10 from a bank of 200,
 * an ordering, a shared rubric — and an item bank is a real assessment requirement. It was not
 * one for L0182, which is why the level was left out on the first pass.
 */
import { NAVIGATION_MODES, SUBMISSION_MODES } from "./attributes.js";

export interface ActivityConfig {
  navigation: (typeof NAVIGATION_MODES)[number];
  submission: (typeof SUBMISSION_MODES)[number];
}

/** One member of an activity: whatever the member emitted, plus its position. */
export interface ActivityItem {
  id: number;
  interaction: Record<string, any>;
  validation?: Record<string, any>;
}

/**
 * Resolve the configuration record into the activity's settings.
 *
 * The defaults are what L0180's delivery already does, rather than what reads best on paper:
 * every item is laid out on one screen, so a candidate can move freely (`nonlinear`) and nothing
 * is submitted until the end (`simultaneous`). L0182 defaults the other way because its delivery
 * genuinely is a linear, per-item flow. A default that contradicts the renderer would be a
 * statement the language cannot keep.
 */
export function resolveConfig(raw: Record<string, any>): ActivityConfig {
  return {
    navigation: raw.navigation !== undefined ? raw.navigation : "nonlinear",
    submission: raw.submission !== undefined ? raw.submission : "simultaneous",
  };
}

/**
 * Number the items by position.
 *
 * The id is the item's place in the authored order, from 0, and it is what a response is keyed
 * by — the same rule `parts` follows one level down, where ids are `"1"`, `"2"`. Derived rather
 * than authored, so nothing can be answered under a name the activity does not present.
 */
export function numberItems(items: Array<Record<string, any>>): ActivityItem[] {
  return items.map((item, i) => ({ id: i, ...item }) as ActivityItem);
}

/** Assemble the compiled activity. */
export function buildActivity(
  items: Array<Record<string, any>>,
  config: Record<string, any>,
): { activity: ActivityConfig & { items: ActivityItem[] } } {
  return { activity: { ...resolveConfig(config), items: numberItems(items) } };
}
