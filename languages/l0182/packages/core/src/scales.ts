// SPDX-License-Identifier: MIT
/**
 * Rating scales: the presets a survey can name, and how any scale a survey writes is checked and
 * normalised.
 *
 * Every form a survey can write — a preset, a list of labelled points, a numeric range with its
 * ends anchored — normalises to ONE shape, an ordered list of points each carrying a value and,
 * where it has one, a label. The compiled record, the response rules and the view all read that
 * one shape, so a Likert scale, an NPS question and a semantic differential cost nothing extra
 * downstream of this file.
 *
 * Like the rest of a survey's data, none of this is written in a program. Messages name the file,
 * because the file is the only thing that locates the fault.
 */
import { normaliseText, showValue } from "./resolve.js";

/** One answerable point on a scale. `value` is what a response records. */
export interface Point {
  value: number;
  /** The words for this point. Numeric scales label only their ends, if that. */
  label?: string;
}

export interface Scale {
  /** The preset or `scales` entry this came from, when it had a name. Lets a view group a grid. */
  name?: string;
  points: Point[];
  /** An answer outside the scale — "Not applicable", "Don't know". Recorded as an opt-out, never a value. */
  optOut?: string;
  /** A rendering hint only. A star scale is still a list of points. */
  display?: "stars";
}

const labelled = (labels: string[]): Point[] => labels.map((label, i) => ({ value: i + 1, label }));

const range = (min: number, max: number, low?: string, high?: string): Point[] => {
  const points: Point[] = [];
  for (let v = min; v <= max; v++) points.push({ value: v });
  if (low) points[0].label = low;
  if (high) points[points.length - 1].label = high;
  return points;
};

/**
 * The scales a survey can name without spelling out. Each is the conventional wording, so a
 * survey that uses one reads the way respondents expect that scale to read.
 */
export const PRESETS: Record<string, Omit<Scale, "name">> = {
  "agreement-5": {
    points: labelled([
      "Strongly disagree",
      "Disagree",
      "Neither agree nor disagree",
      "Agree",
      "Strongly agree",
    ]),
  },
  "agreement-7": {
    points: labelled([
      "Strongly disagree",
      "Disagree",
      "Somewhat disagree",
      "Neither agree nor disagree",
      "Somewhat agree",
      "Agree",
      "Strongly agree",
    ]),
  },
  "frequency-5": { points: labelled(["Never", "Rarely", "Sometimes", "Often", "Always"]) },
  "importance-5": {
    points: labelled([
      "Not at all important",
      "Slightly important",
      "Moderately important",
      "Very important",
      "Extremely important",
    ]),
  },
  "satisfaction-5": {
    points: labelled([
      "Very dissatisfied",
      "Dissatisfied",
      "Neither satisfied nor dissatisfied",
      "Satisfied",
      "Very satisfied",
    ]),
  },
  "likelihood-5": {
    points: labelled([
      "Very unlikely",
      "Unlikely",
      "Neither likely nor unlikely",
      "Likely",
      "Very likely",
    ]),
  },
  nps: { points: range(0, 10, "Not at all likely", "Extremely likely") },
  "stars-5": { points: range(1, 5), display: "stars" },
};

/** Fewest and most points a scale may have. Two is a yes/no; eleven is 0–10. */
const MIN_POINTS = 2;
const MAX_POINTS = 11;

/** Copy a preset, so no compiled record shares an array with the table. */
const fromPreset = (name: string): Scale => {
  const p = PRESETS[name];
  return {
    name,
    points: p.points.map((x) => ({ ...x })),
    ...(p.display ? { display: p.display } : {}),
  };
};

/** Check the points of a scale once it is built: count, order, and labels that can be told apart. */
function assertPoints(where: string, scale: Scale): void {
  const { points } = scale;
  if (points.length < MIN_POINTS || points.length > MAX_POINTS) {
    throw new Error(
      `${where} has ${points.length} points; a scale has ${MIN_POINTS} to ${MAX_POINTS}.`,
    );
  }
  points.forEach((p, i) => {
    if (!Number.isInteger(p.value)) {
      throw new Error(
        `${where}, point ${i + 1} has the value ${showValue(p.value)}; values are whole numbers.`,
      );
    }
    if (i > 0 && p.value <= points[i - 1].value) {
      throw new Error(
        `${where} has the value ${p.value} after ${points[i - 1].value}; a scale's values must rise from its first point to its last.`,
      );
    }
  });
  const seen = new Map<string, number>();
  points.forEach((p, i) => {
    if (p.label === undefined) return;
    const key = normaliseText(p.label);
    if (seen.has(key)) {
      throw new Error(
        `${where} labels points ${seen.get(key)! + 1} and ${i + 1} both ${JSON.stringify(p.label)}, so an answer naming it is ambiguous.`,
      );
    }
    seen.set(key, i);
  });
  if (scale.optOut !== undefined && seen.has(normaliseText(scale.optOut))) {
    throw new Error(
      `${where} has an \`optOut\` of ${JSON.stringify(scale.optOut)}, which is also the label of one of its points. An opt-out is an answer outside the scale; give it its own words.`,
    );
  }
}

const isText = (v: any): v is string => typeof v === "string" && !!v.trim();

/**
 * Read one scale as a survey writes it.
 *
 * `raw` is a preset name, or a record that is one of: `{preset}`, `{points}` (labels valued 1…n,
 * or `{value, label}` records), `{min, max, anchors?}`. Any record may add `optOut` and
 * `display`. `name` is what the scale is called in `scales`, when it is called anything.
 */
export function readScale(where: string, raw: any, name?: string): Scale {
  if (typeof raw === "string") {
    if (!PRESETS[raw]) {
      throw new Error(
        `${where} names the scale ${JSON.stringify(raw)}, which is not a preset. The presets are: ` +
          `${Object.keys(PRESETS).join(", ")} — or define it under \`scales\`.`,
      );
    }
    return fromPreset(raw);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `${where} is ${showValue(raw)}. A scale is a preset name, or a record with \`preset\`, \`points\`, or \`min\` and \`max\`.`,
    );
  }

  const forms = ["preset", "points", "min"].filter((k) => raw[k] !== undefined);
  if (forms.length !== 1) {
    throw new Error(
      `${where} ${forms.length ? `mixes ${forms.map((f) => `\`${f}\``).join(" and ")}` : "says nothing about its points"}. ` +
        "Give exactly one of `preset`, `points`, or `min` and `max`.",
    );
  }

  let scale: Scale;
  if (raw.preset !== undefined) {
    scale = readScale(where, raw.preset);
    if (name) scale.name = name;
  } else if (raw.points !== undefined) {
    if (!Array.isArray(raw.points)) {
      throw new Error(
        `${where} has \`points\` that are ${showValue(raw.points)}; they are a list.`,
      );
    }
    const points: Point[] = raw.points.map((p: any, i: number) => {
      if (isText(p)) return { value: i + 1, label: p.trim() };
      if (p && typeof p === "object" && !Array.isArray(p) && typeof p.value === "number") {
        if (p.label !== undefined && !isText(p.label)) {
          throw new Error(
            `${where}, point ${i + 1} has a \`label\` that is ${showValue(p.label)}.`,
          );
        }
        return { value: p.value, ...(p.label !== undefined ? { label: p.label.trim() } : {}) };
      }
      throw new Error(
        `${where}, point ${i + 1} is ${showValue(p)}. A point is a label, or a record with a numeric \`value\` and an optional \`label\`.`,
      );
    });
    scale = { ...(name ? { name } : {}), points };
  } else {
    const { min, max, anchors } = raw;
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new Error(
        `${where} needs whole-number \`min\` and \`max\`; got ${showValue(min)} and ${showValue(max)}.`,
      );
    }
    if (max <= min) {
      throw new Error(`${where} runs from ${min} to ${max}; \`max\` must be above \`min\`.`);
    }
    if (max - min + 1 > MAX_POINTS) {
      throw new Error(
        `${where} runs from ${min} to ${max}, which is ${max - min + 1} points; a scale has at most ${MAX_POINTS}.`,
      );
    }
    const ends = readAnchors(where, anchors);
    scale = { ...(name ? { name } : {}), points: range(min, max, ends?.[0], ends?.[1]) };
  }

  if (raw.optOut !== undefined) {
    if (!isText(raw.optOut)) {
      throw new Error(
        `${where} has an \`optOut\` that is ${showValue(raw.optOut)}; it is the words for the answer outside the scale.`,
      );
    }
    scale.optOut = raw.optOut.trim();
  }
  if (raw.display !== undefined) {
    if (raw.display !== "stars") {
      throw new Error(
        `${where} has a \`display\` of ${showValue(raw.display)}; the only one is "stars".`,
      );
    }
    scale.display = "stars";
  }
  assertPoints(where, scale);
  return scale;
}

/**
 * Words for the two ends of a scale — "difficult" and "easy" — used by a numeric range and by an
 * item that puts its own words on a shared scale (a semantic differential).
 */
export function readAnchors(where: string, raw: any): [string, string] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length !== 2 || !raw.every(isText)) {
    throw new Error(
      `${where} has \`anchors\` that are ${showValue(raw)}. Anchors are two words, the low end then the high: ["difficult", "easy"].`,
    );
  }
  if (normaliseText(raw[0]) === normaliseText(raw[1])) {
    throw new Error(
      `${where} anchors both ends ${JSON.stringify(raw[0])}; the two ends must differ.`,
    );
  }
  return [raw[0].trim(), raw[1].trim()];
}
