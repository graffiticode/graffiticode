// SPDX-License-Identifier: MIT
/**
 * The attribute vocabulary, as data.
 *
 * Most words here are arity 1: one value in, a single-key record out, which the enclosing
 * container merges. A word marked `chaining` is arity 2 instead — see `AttributeMeta.chaining`.
 * Either way, adding an attribute is a row in this file: the lexicon entry, the Checker method
 * and the Transformer method are all generated from it, arity included, so a word can never be
 * arity 1 in one place and arity 2 in another. Never hand-write a handler. See
 * console/docs/language-authoring-style.md.
 *
 * `field` and `coerce` are transcribed from L0166's per-word transformers, not inferred. They
 * are not uniform and the differences are load-bearing for byte-identical output:
 *   - most style attributes emit a KEBAB key (`'background-color'`), not the camelCase name;
 *   - `hide-formulabar` emits `hideMenu`, the one word whose field is unrelated to its spelling;
 *   - most style attributes coerce through `tagValue(v) || ''`, so a bare tag and a quoted
 *     string are the same thing and an absent value becomes "" rather than undefined;
 *   - `align` coerces WITHOUT the `|| ''` fallback, and `method` lowercases.
 * A uniform pass-through table would have silently changed all of that.
 */

/** L0166's `tagValue`: a Transformer value is a string, or a `{tag}` record. */
export const tagValue = (v: any): string | undefined =>
  (typeof v === "string" && v) || (v && typeof v.tag === "string" && v.tag) || undefined;

const asTag = (v: any) => tagValue(v) || "";

export type Shape = "object";

/**
 * The argument type an attribute accepts. Omitted means anything goes (L0166 leaves `text`,
 * `expected`, `title`, `instructions` and `protected` unchecked, so those stay unchecked here).
 *
 *   "string"  a string, or a bare tag — `color "red"` and `color red` are the same thing
 *   "number"  a finite number
 *   "boolean" a boolean literal
 */
export type Expects = "string" | "number" | "boolean";

export interface AttributeMeta {
  /** The key this attribute emits. */
  field: string;
  /** How the argument is read; omitted means "a value, passed through". */
  shape?: Shape;
  /** Value coercion, transcribed from L0166. Omitted means the value is used as-is. */
  coerce?: (v: any) => any;
  /** Argument type, enforced in the Transformer — see checkType and §7.1 of the style guide. */
  expects?: Expects;
  /**
   * A CHAINING attribute: arity 2 rather than arity 1, taking its value and the rest of the
   * chain, and merging the two. It is written after a member list instead of inside an
   * attribute list:
   *
   *     sheets [ ... ] title "Quarterly Totals" show-sheet-tabs true {}
   *
   * That position is the `sheets` configuration slot, which is where `params` already goes — so
   * this needs no new grammar, only a second arity. It exists because `title` and `instructions`
   * describe the PROGRAM, not a sheet: with two sheets, a title written inside one of them has
   * no defensible meaning. L0166 chains them at its top level for the same reason; L0179's port
   * pushed them down into the sheet, and this puts them back.
   *
   * A word has exactly one arity (`parser/src/folder.js` reads `word.arity`), so marking one
   * chaining REMOVES it from attribute lists. That is a breaking source change, not an addition.
   */
  chaining?: boolean;
  /**
   * An extra rule beyond the type, run after it. Returns an error message, or null to accept.
   *
   * Exists because a type check is not always enough to keep a value MEANINGFUL: `font-size "16"`
   * is a perfectly good string that is not a CSS length, so it reaches the renderer and is
   * silently ignored. That is the same silent-drop failure the type checks were added to close,
   * one level down.
   */
  validate?: (v: any) => string | null;
}

/** CSS keywords a font size may legitimately be instead of a length. */
const FONT_SIZE_KEYWORDS = new Set([
  "xx-small", "x-small", "small", "medium", "large", "x-large", "xx-large",
  "smaller", "larger", "inherit", "initial", "unset",
]);

/**
 * A CSS length: a number followed by a unit. React passes a style string through untouched, so a
 * unitless "16" becomes `font-size: 16`, which browsers discard — the text renders at the default
 * size with nothing to say why. Every font-size in L0166's corpus is written with `px`.
 */
function cssSize(v: any): string | null {
  const s = tagValue(v);
  if (s === undefined) return null;           // the type check already reported this
  if (FONT_SIZE_KEYWORDS.has(s.toLowerCase())) return null;
  if (/^-?(\d+\.?\d*|\.\d+)(px|pt|pc|em|rem|ex|ch|vw|vh|vmin|vmax|%|in|cm|mm|q)$/i.test(s.trim())) return null;
  return `E_INVALID_SIZE: font-size "${s}" needs a unit, e.g. "14px" — a bare number is not a CSS size and does not render.`;
}

/**
 * Reject an argument of the wrong type.
 *
 * This lives in the TRANSFORMER, not the Checker, and the reason is load-bearing: the base
 * `Checker.LIST` visits only its first element, so a Checker rule in this style fires for the
 * first attribute of a list and silently skips the rest. L0166 puts these checks in its Checker
 * and gets away with it because its attributes chain rather than sit in a list.
 *
 * Without this L0179 was strictly MORE PERMISSIVE than L0166 — `font-size 14` compiled to
 * `font-size: ""`, dropping the value with no error, where L0166 says
 * `E_ARG_TYPE: FONT_SIZE expects a string`. The differential test could not see it: it compares
 * programs that compile in BOTH languages, so it is blind to L0179 accepting what L0166 rejects.
 */
export function checkType(name: string, meta: AttributeMeta, raw: any): string | null {
  if (!meta.expects) return null;
  const word = name.toLowerCase().replace(/_/g, "-");
  switch (meta.expects) {
  case "string":
    // A bare tag is a string here: `align center` and `align "center"` both reach the target.
    if (tagValue(raw) === undefined) {
      return `E_ARG_TYPE: ${word} expects a string, got ${describe(raw)}.`;
    }
    return null;
  case "number":
    if (typeof raw !== "number" || !isFinite(raw)) {
      return `E_ARG_TYPE: ${word} expects a number, got ${describe(raw)}.`;
    }
    if (name === "POINTS" && raw < 0) {
      return `E_INVALID_POINTS: ${raw} must be >= 0.`;
    }
    return null;
  case "boolean":
    if (typeof raw !== "boolean") {
      return `E_ARG_TYPE: ${word} expects true or false, got ${describe(raw)}.`;
    }
    return null;
  default:
    return null;
  }
}

/** Type first, then the attribute's own rule. Returns the first error, or null. */
export function checkValue(name: string, meta: AttributeMeta, raw: any): string | null {
  return checkType(name, meta, raw) ?? (meta.validate ? meta.validate(raw) : null);
}

/** Name a bad value the way its author wrote it, so the message points at the mistake. */
function describe(v: any): string {
  if (v === null || v === undefined) return "nothing";
  if (typeof v === "number") return `the number ${v}`;
  if (typeof v === "boolean") return `${v}`;
  if (Array.isArray(v)) return "a list";
  if (typeof v === "object") return "a record";
  return `\`${String(v)}\``;
}

export const attributeFields: Record<string, AttributeMeta> = {
  // Content
  TEXT: { field: "text" },

  // Presentation. Note the kebab fields and the `|| ''` coercion — see the header.
  WIDTH: { field: "width", expects: "number" },
  ALIGN: { field: "align", coerce: tagValue, expects: "string" },
  BACKGROUND_COLOR: { field: "background-color", coerce: asTag, expects: "string" },
  FONT_WEIGHT: { field: "font-weight", coerce: asTag, expects: "string" },
  FONT_SIZE: { field: "font-size", coerce: asTag, expects: "string", validate: cssSize },
  FONT_FAMILY: { field: "font-family", coerce: asTag, expects: "string" },
  FONT_STYLE: { field: "font-style", coerce: asTag, expects: "string" },
  COLOR: { field: "color", coerce: asTag, expects: "string" },
  TEXT_DECORATION: { field: "text-decoration", coerce: asTag, expects: "string" },
  BORDER: { field: "border", coerce: asTag, expects: "string" },
  VERTICAL_ALIGN: { field: "vertical-align", coerce: asTag, expects: "string" },
  FORMAT: { field: "format", coerce: asTag, expects: "string" },
  // spec/schema.json declares protected a boolean on cell, column, row and region.
  // Leaving it unchecked here let `protected "true"` compile clean, and the string
  // only blew up one layer up, where a host dialect (L0176) validates an embedded
  // sheet against that schema: "must be boolean". Because the sheet itself
  // compiled, the repair loop never saw an error to repair.
  PROTECTED: { field: "protected", expects: "boolean" },

  // Assessment
  ASSESS: { field: "assess", shape: "object" },
  METHOD: { field: "method", coerce: (v) => tagValue(v)?.toLowerCase() || v, expects: "string" },
  EXPECTED: { field: "expected" },
  POINTS: { field: "points", expects: "number" },

  // Sheet-level
  NAME: { field: "name", coerce: asTag, expects: "string" },
  HIDE_FORMULABAR: { field: "hideMenu", expects: "boolean" },

  // Program-level, written in the `sheets` configuration slot. See `chaining` above.
  //
  // NAMING HAZARD, and it is not hypothetical: `hide-formulabar` emits `hideMenu` — L0166's one
  // word whose field is unrelated to its spelling — and it means the FORMULA BAR. `hideSheetMenu`
  // sits next to it and means the SHEET MENU, a different control entirely. Read the field names
  // here, not the resemblance.
  TITLE: { field: "title", chaining: true },
  INSTRUCTIONS: { field: "instructions", chaining: true },
  SHOW_SHEET_TABS: { field: "showSheetTabs", expects: "boolean", chaining: true },
  HIDE_SHEET_MENU: { field: "hideSheetMenu", expects: "boolean", chaining: true },
  // Whether assess feedback colours the grid as the learner types, or waits for a check (the
  // host's Check button, or Learnosity's Check Answer). Emitted as top-level `feedback`, a mode
  // (`"instant"` or `"check"`) rather than a boolean; absent means the default, on check.
  // NOT `instantFeedback`: learnosity-cqt keeps Learnosity's own instant_feedback under that key
  // and spreads the compiled model over it, so the program's value would silently replace it.
  INSTANT_FEEDBACK: {
    field: "feedback",
    expects: "boolean",
    coerce: (v) => (v ? "instant" : "check"),
    chaining: true,
  },
};

/**
 * Source spelling for each emitted field, so an error message names the word the author wrote
 * rather than the key it compiles to — `hide-formulabar`, never `hideMenu`.
 */
export const fieldToWord: Record<string, string> = Object.entries(attributeFields).reduce(
  (acc, [name, meta]) => {
    acc[meta.field] = name.toLowerCase().replace(/_/g, "-");
    return acc;
  },
  // Seeded with the one field no row in the table produces: `params` is a hand-written container,
  // not a generated attribute, but it evaluates into the same `sheets` slot and so has to be
  // nameable when the slot rejects something.
  { templateVariablesRecords: "params" } as Record<string, string>,
);

/**
 * Which attributes each container accepts, in source spelling.
 *
 * This is the payoff of the style and the reason it is maintained by hand: an attribute list
 * merges whatever it is handed, so without this a word written one level too high lands in a
 * record nothing reads, compiles clean, and silently does not do what it says. L0176 shipped
 * exactly that at its block levels before adding this check.
 */
export const validAttributes: Record<string, string[]> = {
  // The `sheets` configuration slot. `v` is not an attribute — it is the version marker every
  // program carries as `{"v": "0.0.1"}`, which PROG destructures away and never emits. It has to
  // be listed, because this map is what turns validation ON for a container: before there was a
  // SHEETS entry, `assertKnownAttributes` returned early and the whole slot went unchecked.
  SHEETS: [
    "title", "instructions", "show-sheet-tabs", "hide-sheet-menu", "instant-feedback", "params", "v",
  ],
  SHEET: ["name", "hide-formulabar", "columns", "rows", "cells"],
  CELL: [
    "text", "assess", "width", "align", "background-color", "font-weight", "font-size",
    "font-family", "font-style", "color", "text-decoration", "border", "vertical-align",
    "format", "protected",
  ],
  COLUMN: [
    "width", "align", "background-color", "font-weight", "font-size", "font-family",
    "font-style", "color", "text-decoration", "border", "vertical-align", "format",
    "protected", "assess",
  ],
  ROW: [
    "align", "background-color", "font-weight", "font-size", "font-family", "font-style",
    "color", "text-decoration", "border", "vertical-align", "format", "protected", "assess",
  ],
  ASSESS: ["method", "expected", "points"],
};

/** Containers that legitimately own each word, for the "belongs to" hint. */
const wordOwners: Record<string, string[]> = Object.entries(validAttributes).reduce(
  (acc, [container, words]) => {
    for (const w of words) (acc[w] = acc[w] || []).push(container.toLowerCase());
    return acc;
  },
  {} as Record<string, string[]>,
);

/**
 * Reject attributes a container does not take.
 *
 * The message is a product surface: the code generator is an LLM that reads compiler output and
 * retries, so it names the legal set AND where the attribute actually belongs. The second half
 * is the high-leverage one — an L0176 error of this shape took a deterministic failure to 10/10
 * once the misplacement was spelled out.
 */
export function assertKnownAttributes(container: string, attrs: Record<string, unknown>) {
  const allowed = validAttributes[container];
  if (!allowed) return;
  const where = container.toLowerCase();
  const unknown = Object.keys(attrs)
    .map((field) => fieldToWord[field] || field)
    .filter((word) => !allowed.includes(word));
  if (unknown.length === 0) return;
  const hints = unknown
    .map((w) => {
      const owners = (wordOwners[w] || []).filter((o) => o !== where);
      return owners.length ? ` \`${w}\` belongs to ${owners.join(" or ")}.` : "";
    })
    .join("");
  throw new Error(
    `${where}: ${unknown.map((u) => `\`${u}\``).join(", ")} ` +
      `${unknown.length === 1 ? "is not an attribute" : "are not attributes"} of ${where}. ` +
      `It takes: ${allowed.join(", ")}.${hints}`,
  );
}

/**
 * Merge an attribute list into one object.
 *
 * Throws rather than silently dropping: a malformed entry is a compile error, because the
 * alternative is a program that looks right and quietly loses an attribute.
 */
export function mergeAttributes(attrs: any, where: string): Record<string, any> {
  if (!Array.isArray(attrs)) {
    throw new Error(`${where}: expected an attribute list in [brackets], e.g. [text "Total"].`);
  }
  const out: Record<string, any> = {};
  for (const a of attrs) {
    if (a === null || a === undefined || typeof a !== "object" || Array.isArray(a)) {
      throw new Error(
        `${where}: every entry must be an attribute applied to a value, e.g. [text "Total" width 100].`,
      );
    }
    Object.assign(out, a);
  }
  return out;
}
