// SPDX-License-Identifier: MIT
/**
 * The vocabulary as data.
 *
 * Adding a word is a row in this file: its lexicon entry, its Checker method and its Transformer
 * method are generated from the row, arity included, so a word can never be declared with one
 * arity and handled with another. Never hand-write a word's handler.
 *
 * The style is `docs/language-style-typed-chains.md`. Everything that describes one thing is a
 * CHAIN: each word takes its value and the rest of the chain, and the chain ends in a record, so
 * `text "Kickoff" x 40 y 80 {}` computes `{text, x, y}`.
 *
 * Four construct shapes, and only four:
 *
 * - CONTAINER (arity 2): a member list, then a settings chain. `board`, `page`, `section`.
 * - MEMBER (arity 1): one description chain. `sticky`, `shape`, `textbox`, `stamp`, `connector`.
 * - PROPERTY (arity 2): a value, then the rest of the chain. Everything else.
 * - TAG (arity 0): a closed-set value, written bare and uppercase: `kind DIAMOND`, `to-cap ARROW_LINES`.
 *
 * Plus one statement, `save-to-figjam "<file key or link>"` (arity 1), written on its own line
 * beside the board.
 */

/* ------------------------------------------------------------------ closed sets */

/** FigJam's shape-with-text kinds, spelled as Figma's `shapeType` enum and emitted unchanged. */
export const SHAPE_KINDS = [
  "SQUARE",
  "ELLIPSE",
  "ROUNDED_RECTANGLE",
  "DIAMOND",
  "TRIANGLE_UP",
  "TRIANGLE_DOWN",
  "PARALLELOGRAM_RIGHT",
  "PARALLELOGRAM_LEFT",
  "ENG_DATABASE",
  "ENG_QUEUE",
  "ENG_FILE",
  "ENG_FOLDER",
  "TRAPEZOID",
  "PREDEFINED_PROCESS",
  "SHIELD",
  "DOCUMENT_SINGLE",
  "DOCUMENT_MULTIPLE",
  "MANUAL_INPUT",
  "HEXAGON",
  "CHEVRON",
  "PENTAGON",
  "OCTAGON",
  "STAR",
  "PLUS",
  "ARROW_LEFT",
  "ARROW_RIGHT",
  "SUMMING_JUNCTION",
  "OR",
  "SPEECH_BUBBLE",
  "INTERNAL_STORAGE",
] as const;
export const STAMP_KINDS = ["LIKE", "LOVE", "LAUGH", "SURPRISED", "CELEBRATE", "HEART"] as const;
export const LINE_TYPES = ["STRAIGHT", "ELBOWED", "CURVED"] as const;
export const LINE_STYLES = ["SOLID", "DASHED"] as const;
export const CAPS = ["NONE", "ARROW_LINES", "ARROW_EQUILATERAL", "TRIANGLE_FILLED", "CIRCLE_FILLED", "DIAMOND_FILLED"] as const;
export const SIDES = ["AUTO", "TOP", "BOTTOM", "LEFT", "RIGHT", "CENTER"] as const;
/** Font-size presets, in pixels. */
export const FONT_SIZES: Record<string, number> = { SMALL: 16, MEDIUM: 24, LARGE: 40, EXTRA_LARGE: 64, HUGE: 96 };
/** Stroke-width presets, in pixels. */
export const STROKE_WIDTHS: Record<string, number> = { THIN: 4, THICK: 8 };

/**
 * The ten colour names the FigJam plugin resolves, with the hex it resolves each to. Anything
 * else must be a hex code; the plugin would draw an unknown name grey.
 */
export const NAMED_COLORS: Record<string, string> = {
  red: "#ef4444",
  blue: "#3b82f6",
  green: "#22c55e",
  yellow: "#eab308",
  purple: "#a855f7",
  orange: "#f97316",
  pink: "#ec4899",
  white: "#ffffff",
  black: "#000000",
  gray: "#6b7280",
};

const lower = (t: string) => t.toLowerCase().replace(/_/g, "-");

/** Every tag, with the line its lexicon entry carries. One entry per spelling. */
export const TAGS: Record<string, string> = {
  ...Object.fromEntries(SHAPE_KINDS.map((k) => [k, `A ${lower(k).replace(/-/g, " ")} shape.`])),
  LIKE: "A thumbs-up stamp.",
  LOVE: "A heart-eyes (love) stamp.",
  LAUGH: "A laughing stamp.",
  SURPRISED: "A surprised stamp.",
  CELEBRATE: "A party (celebrate) stamp.",
  HEART: "A heart stamp.",
  STRAIGHT: "A straight connector.",
  ELBOWED: "A connector drawn in right-angled segments (the default).",
  CURVED: "A curved connector.",
  SOLID: "A solid line (the default).",
  DASHED: "A dashed line.",
  NONE: "No end cap.",
  ARROW_LINES: "An open arrowhead.",
  ARROW_EQUILATERAL: "A filled triangular arrowhead.",
  TRIANGLE_FILLED: "A filled triangle.",
  CIRCLE_FILLED: "A filled circle.",
  DIAMOND_FILLED: "A filled diamond.",
  AUTO: "Whichever side faces the other end (elbowed and curved connectors).",
  TOP: "The top side.",
  BOTTOM: "The bottom side.",
  LEFT: "The left side.",
  RIGHT: "The right side.",
  CENTER: "The centre (straight connectors only).",
  SMALL: "16px text.",
  MEDIUM: "24px text.",
  LARGE: "40px text.",
  EXTRA_LARGE: "64px text.",
  HUGE: "96px text.",
  THIN: "A 4px line.",
  THICK: "An 8px line.",
};

/* ------------------------------------------------------------------ word metadata */

/**
 * How a value is checked and turned into the field it emits.
 *
 * - `text`: a non-empty string (a number is accepted and emitted as a string).
 * - `content`: a string that may be empty — what a node says.
 * - `coord`: a finite number, negative allowed.
 * - `size`: a number above 0.
 * - `opacity`: a number from 0 to 100.
 * - `boolean`: a bare `true` or `false`.
 * - `tag`: one of `oneOf`, written bare; emitted through `emit`.
 * - `tagOrNumber`: one of `oneOf`, or a number above 0; a tag is emitted as its `presets` value.
 * - `color`: a hex code ("#ffcc00") or one of `NAMED_COLORS`.
 * - `endpoints`: a node's key, a list of keys, or "*" — resolved per page in `board.ts`.
 * - `point`: an `[x y]` pair of numbers, emitted as `{x, y}`.
 * - `waypoints`: a list of `waypoint` members, emitted as their points in order.
 */
export type Expects =
  | "text"
  | "content"
  | "coord"
  | "size"
  | "opacity"
  | "boolean"
  | "tag"
  | "tagOrNumber"
  | "color"
  | "endpoints"
  | "point"
  | "waypoints"
  | "record";

export interface AttributeMeta {
  field: string;
  expects: Expects;
  oneOf?: readonly string[];
  /** How a tag is written into the output; the tag itself when absent. */
  emit?: (tag: string) => any;
  description: string;
}

/** Arity 2: properties. Each takes its value AND the rest of the chain. */
export const chainFields: Record<string, AttributeMeta> = {
  ID: {
    field: "id",
    expects: "text",
    description:
      "The name connectors use to refer to a node. Defaults to the node's text, so give an id whenever two nodes say the same thing or the text is long.",
  },
  TEXT: { field: "text", expects: "content", description: "What a sticky, shape or textbox says." },
  NAME: { field: "name", expects: "text", description: "A section's or a page's name, shown as its title or tab." },
  LABEL: { field: "label", expects: "content", description: "Text written on a connector." },
  TITLE: { field: "title", expects: "text", description: "The board's title, after the board's `]`." },
  KIND: {
    field: "kind",
    expects: "tag",
    oneOf: [...SHAPE_KINDS, ...STAMP_KINDS],
    description: `A shape's outline (${SHAPE_KINDS.join(", ")}; defaults to SQUARE), or a stamp's reaction (${STAMP_KINDS.join(", ")}; required).`,
  },
  X: { field: "x", expects: "coord", description: "Distance from the left of the page, in pixels. Defaults to 0." },
  Y: { field: "y", expects: "coord", description: "Distance from the top of the page, in pixels. Defaults to 0." },
  WIDTH: { field: "width", expects: "size", description: "Width in pixels. Defaults to FigJam's size for the shape, or to fit a section's contents." },
  HEIGHT: { field: "height", expects: "size", description: "Height in pixels. Defaults like width." },
  FILL: {
    field: "fill",
    expects: "color",
    description: `The background colour of a sticky, shape or section: a hex code like "#ffcc00", or ${Object.keys(NAMED_COLORS).join(", ")}.`,
  },
  STROKE: { field: "stroke", expects: "color", description: "The outline colour of a shape, or a connector's line colour." },
  COLOR: { field: "color", expects: "color", description: "A textbox's text colour." },
  OPACITY: { field: "opacity", expects: "opacity", description: "How opaque, from 0 (invisible) to 100 (solid). Defaults to 100." },
  FONT_SIZE: {
    field: "fontSize",
    expects: "tagOrNumber",
    oneOf: Object.keys(FONT_SIZES),
    emit: (t) => FONT_SIZES[t],
    description: "Text size: SMALL (16), MEDIUM (24), LARGE (40), EXTRA_LARGE (64), HUGE (96), or a number of pixels.",
  },
  STROKE_WIDTH: {
    field: "strokeWidth",
    expects: "tagOrNumber",
    oneOf: Object.keys(STROKE_WIDTHS),
    emit: (t) => STROKE_WIDTHS[t],
    description: "Line thickness: THIN (4), THICK (8), or a number of pixels.",
  },
  FROM: {
    field: "from",
    expects: "endpoints",
    description: 'Where a connector starts: a node\'s id (or text), a list of them to fan in, or "*" for every other node on the page.',
  },
  TO: {
    field: "to",
    expects: "endpoints",
    description: 'Where a connector ends: a node\'s id (or text), a list of them to fan out, or "*" for every other node on the page.',
  },
  LINE_TYPE: {
    field: "lineType",
    expects: "tag",
    oneOf: LINE_TYPES,
    emit: lower,
    description: "A connector's path: ELBOWED (the default), STRAIGHT or CURVED.",
  },
  LINE_STYLE: {
    field: "lineStyle",
    expects: "tag",
    oneOf: LINE_STYLES,
    emit: lower,
    description: "A connector's dash: SOLID (the default) or DASHED.",
  },
  FROM_CAP: {
    field: "fromCap",
    expects: "tag",
    oneOf: CAPS,
    emit: lower,
    description: `The cap at a connector's start: ${CAPS.join(", ")}. Defaults to NONE.`,
  },
  TO_CAP: {
    field: "toCap",
    expects: "tag",
    oneOf: CAPS,
    emit: lower,
    description: `The cap at a connector's end: ${CAPS.join(", ")}. Defaults to ARROW_LINES.`,
  },
  FROM_SIDE: {
    field: "fromSide",
    expects: "tag",
    oneOf: SIDES,
    emit: lower,
    description: `Which side of the start node a connector leaves from: ${SIDES.join(", ")}. Defaults to AUTO (the facing side) for ELBOWED and CURVED connectors, CENTER for STRAIGHT ones; only a STRAIGHT connector can use CENTER.`,
  },
  TO_SIDE: {
    field: "toSide",
    expects: "tag",
    oneOf: SIDES,
    emit: lower,
    description: "Which side of the end node a connector arrives at. Same choices and default as from-side.",
  },
  WAYPOINTS: {
    field: "waypoints",
    expects: "waypoints",
    description:
      "Points a connector passes through on its way, in order: waypoints [ waypoint [300 0] waypoint [300 400] ]. Needs a single from and a single to.",
  },
  BACKGROUND: { field: "background", expects: "color", description: "A page's canvas colour." },
  SHOW_PAGE_TABS: {
    field: "showPageTabs",
    expects: "boolean",
    description: "Show a tab per page. Defaults to true with two or more pages, false with one.",
  },
  SHOW_PAGE_MENU: {
    field: "showPageMenu",
    expects: "boolean",
    description: "Show the page menu, which lists every page. Defaults to false.",
  },
};

/** Arity 1: the typed members. Each takes a description and returns `{[word]: record}`. */
export const memberFields: Record<string, AttributeMeta> = {
  STICKY: { field: "sticky", expects: "record", description: 'A sticky note, e.g. `sticky id "kick" text "Kickoff" x 0 y 0 {}`.' },
  SHAPE: { field: "shape", expects: "record", description: 'A shape with text, e.g. `shape kind DIAMOND text "Valid?" x 300 y 0 {}`.' },
  TEXTBOX: { field: "textbox", expects: "record", description: 'Free text on the page, e.g. `textbox text "Roadmap" font-size LARGE {}`.' },
  STAMP: { field: "stamp", expects: "record", description: "A reaction stamp, e.g. `stamp kind LIKE x 200 y 300 {}`." },
  CONNECTOR: { field: "connector", expects: "record", description: 'A line between nodes, e.g. `connector from "kick" to "valid" {}`.' },
  WAYPOINT: {
    field: "waypoint",
    expects: "point",
    description: "A point a connector passes through, as an [x y] pair of page pixels, inside `waypoints [ … ]`, e.g. `waypoint [300 0]`. It takes no `{}`.",
  },
};

/** Arity 2: the containers. A member list, then a settings chain. */
export const containerFields: Record<string, { word: string; description: string }> = {
  BOARD: { word: "board", description: "The program: the FigJam board's pages, then its settings (title, show-page-tabs, show-page-menu)." },
  PAGE: { word: "page", description: "One page: its nodes and connectors, then its settings (name, background)." },
  SECTION: { word: "section", description: "A titled area of a page holding nodes, then its settings (name, x, y, width, height, fill, opacity)." },
};

/** The one statement: arity 1, written on its own line beside the board. */
export const SAVE_TO_FIGJAM = {
  name: "SAVE_TO_FIGJAM",
  word: "save-to-figjam",
  field: "saveToFigjam",
  description:
    'Draw this board into a FigJam file with the Graffiticode FigJam plugin: `save-to-figjam "<file key or figma.com link>"`, on its own line before the board.',
};

/* ------------------------------------------------------------------ legality */

/**
 * Which words each description accepts, in source spelling.
 *
 * Maintained by hand, because a chain builds whatever record it is handed: a word written in the
 * wrong description lands in a record nothing reads, compiles clean, and silently does nothing.
 */
export const validAttributes: Record<string, string[]> = {
  sticky: ["id", "text", "x", "y", "fill", "opacity", "font-size"],
  shape: ["id", "kind", "text", "x", "y", "width", "height", "fill", "stroke", "stroke-width", "opacity", "font-size"],
  textbox: ["id", "text", "x", "y", "color", "opacity", "font-size"],
  stamp: ["kind", "x", "y", "opacity"],
  connector: [
    "from",
    "to",
    "label",
    "line-type",
    "line-style",
    "from-cap",
    "to-cap",
    "from-side",
    "to-side",
    "stroke",
    "stroke-width",
    "opacity",
    "font-size",
    "waypoints",
  ],
};

/** Which settings each container's settings chain accepts. */
export const validSettings: Record<string, string[]> = {
  board: ["title", "show-page-tabs", "show-page-menu"],
  page: ["name", "background"],
  section: ["name", "x", "y", "width", "height", "fill", "opacity"],
};

/** Which members each container's list holds. */
export const containerMembers: Record<string, string[]> = {
  board: ["page"],
  page: ["sticky", "shape", "textbox", "stamp", "section", "connector"],
  section: ["sticky", "shape", "textbox", "stamp"],
  waypoints: ["waypoint"],
};

/* ------------------------------------------------------------------ spelling */

export const wordOf = (name: string): string => name.toLowerCase().replace(/_/g, "-");

const wordByField: Record<string, string> = {
  ...Object.fromEntries(Object.entries({ ...chainFields, ...memberFields }).map(([name, meta]) => [meta.field, wordOf(name)])),
  [SAVE_TO_FIGJAM.field]: SAVE_TO_FIGJAM.word,
};
/** The source word that emits `field`, for error messages (`fontSize` is `font-size`). */
export const sourceWord = (field: string): string => wordByField[field] ?? field;

/** The signature string the generated spec renders, derived so it cannot drift from the row. */
export const typeOf = (meta: AttributeMeta, arity: 1 | 2): string => {
  const arg = (
    {
      record: "record",
      coord: "number",
      size: "number",
      opacity: "number",
      boolean: "boolean",
      tag: "tag",
      tagOrNumber: "tag|number",
      endpoints: "string|list",
      point: "list",
      waypoints: "list",
    } as Record<string, string>
  )[meta.expects] ?? "string";
  return arity === 1 ? `<${arg}: record>` : `<${arg} record: record>`;
};

/* ------------------------------------------------------------------ values */

/**
 * Unwrap L0000's internal Record representation to plain JS.
 *
 * A `{...}` literal reaching a Transformer is `{_type: "record", _entries: Map}` with keys encoded
 * `tag:`/`str:`/`num:`. L0000 does not export a reader for it. Dot-access without this silently
 * misses.
 */
export function toPlainObject(val: any): any {
  if (val !== null && typeof val === "object" && val._type === "record" && val._entries instanceof Map) {
    const obj: any = {};
    for (const [k, v] of val._entries) obj[(k as string).replace(/^(tag|str|num):/, "")] = toPlainObject(v);
    return obj;
  }
  if (Array.isArray(val)) return val.map(toPlainObject);
  return val;
}

/** A bare tag (`DIAMOND`) reaches the Transformer as `{tag: "DIAMOND"}`. */
export const isTag = (v: any): boolean => v !== null && typeof v === "object" && !Array.isArray(v) && typeof v.tag === "string";

export const isRecord = (v: any): boolean => v !== null && typeof v === "object" && !Array.isArray(v) && !isTag(v);

/** A value as it was written, for an error message. */
export function showValue(v: any): string {
  if (v === undefined) return "nothing";
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (isTag(v)) return `the tag ${v.tag}`;
  if (Array.isArray(v)) return "a list";
  if (typeof v === "object") return "a record";
  return String(v);
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const finite = (v: any): boolean => typeof v === "number" && Number.isFinite(v);

/** A tag written as a quoted string, and the fix. */
const quotedTag = (word: string, raw: any, oneOf: readonly string[] = []): string => {
  if (typeof raw !== "string") return "";
  const t = oneOf.find((v) => v.toLowerCase() === raw.trim().toLowerCase().replace(/[- ]/g, "_"));
  return t ? ` Write it bare and uppercase, without quotes: ${word} ${t}.` : "";
};

/**
 * Check and normalize a value. Returns `{value}` or `{error}`.
 *
 * This runs in the TRANSFORMER, not the Checker: `Checker.LIST` visits only `elts[0]`, so a rule
 * written as a Checker method would fire on the first element of a list and nowhere else.
 */
export function checkValue(name: string, meta: AttributeMeta, raw: any): { value?: any; error?: string } {
  const word = wordOf(name);
  switch (meta.expects) {
    case "text":
    case "content": {
      if (finite(raw)) raw = String(raw);
      if (typeof raw !== "string") return { error: `${word}: expected a string in "quotes", got ${showValue(raw)}.` };
      if (meta.expects === "text" && !raw.trim()) return { error: `${word}: must not be empty.` };
      return { value: raw };
    }
    case "coord":
      if (!finite(raw)) return { error: `${word}: expected a number of pixels, got ${showValue(raw)}.` };
      return { value: raw };
    case "size":
      if (!finite(raw) || raw <= 0) return { error: `${word}: expected a number of pixels above 0, got ${showValue(raw)}.` };
      return { value: raw };
    case "opacity":
      if (!finite(raw) || raw < 0 || raw > 100) {
        return { error: `${word}: expected a number from 0 to 100, got ${showValue(raw)}.${finite(raw) && raw > 0 && raw <= 1 ? ` Opacity is a percentage: write ${word} ${Math.round(raw * 100)}.` : ""}` };
      }
      return { value: raw };
    case "boolean":
      if (typeof raw === "boolean") return { value: raw };
      return {
        error: `${word}: expected true or false, written bare, got ${showValue(raw)}.${raw === "true" || raw === "false" ? ` Write it without quotes: ${word} ${raw}.` : ""}`,
      };
    case "tag": {
      if (isTag(raw) && (!meta.oneOf || meta.oneOf.includes(raw.tag))) return { value: meta.emit ? meta.emit(raw.tag) : raw.tag };
      return { error: `${word}: expected one of ${(meta.oneOf || []).join(", ")}, got ${showValue(raw)}.${quotedTag(word, raw, meta.oneOf)}` };
    }
    case "tagOrNumber": {
      if (isTag(raw) && meta.oneOf?.includes(raw.tag)) return { value: meta.emit!(raw.tag) };
      if (finite(raw) && raw > 0) return { value: raw };
      return {
        error: `${word}: expected one of ${(meta.oneOf || []).join(", ")}, or a number of pixels above 0, got ${showValue(raw)}.${quotedTag(word, raw, meta.oneOf)}`,
      };
    }
    case "color": {
      if (typeof raw === "string") {
        const c = raw.trim();
        if (HEX.test(c)) return { value: c };
        if (NAMED_COLORS[c.toLowerCase()]) return { value: c.toLowerCase() };
      }
      return {
        error: `${word}: expected a hex colour like "#ffcc00" or one of ${Object.keys(NAMED_COLORS).join(", ")}, got ${showValue(raw)}.`,
      };
    }
    case "endpoints": {
      const ok = (s: any) => (typeof s === "string" && s.trim() !== "") || finite(s);
      if (ok(raw)) return { value: String(raw) };
      if (Array.isArray(raw) && raw.length && raw.every(ok)) return { value: raw.map(String) };
      return { error: `${word}: expected a node's id in "quotes", a list of ids like ["a" "b"], or "*", got ${showValue(raw)}.` };
    }
    case "point":
      if (!Array.isArray(raw) || raw.length !== 2 || !raw.every(finite)) {
        return { error: `${word}: expected an [x y] pair of numbers, like ${exampleOf(word)}, got ${showValue(raw)}.` };
      }
      return { value: { x: raw[0], y: raw[1] } };
    case "waypoints": {
      const example = "waypoints [ waypoint [300 0] waypoint [300 400] ]";
      if (!Array.isArray(raw)) return { error: `${word}: expected a list of waypoints, like ${example}, got ${showValue(raw)}.` };
      if (!raw.length) return { error: `${word}: needs at least one waypoint, like ${example}.` };
      const points: any[] = [];
      for (const [i, m] of raw.entries()) {
        const keys = isRecord(m) ? Object.keys(m) : [];
        if (isRecord(m) && !keys.length) {
          return { error: `${word}: item ${i + 1} is a stray \`{}\`. A waypoint takes only its pair: write waypoint [300 0], not waypoint [300 0] {}.` };
        }
        if (keys.length !== 1 || keys[0] !== "waypoint") {
          const what = keys.length === 1 ? `a \`${sourceWord(keys[0])}\`` : showValue(m);
          return { error: `${word}: item ${i + 1} is ${what}, which is not a waypoint. Write each one as waypoint [x y], like ${example}.` };
        }
        points.push(m.waypoint);
      }
      return { value: points };
    }
    case "record":
      if (!isRecord(raw)) return { error: `${word}: expected a description ending in \`{}\`, e.g. ${exampleOf(word)}, got ${showValue(raw)}.` };
      return { value: raw };
  }
}

/* ------------------------------------------------------------------ messages */

/** A description written the way it should be, for error messages. */
export const exampleOf = (word: string): string =>
  ({
    sticky: 'sticky id "kick" text "Kickoff" x 0 y 0 {}',
    shape: 'shape kind DIAMOND id "valid" text "Valid?" x 300 y 0 {}',
    textbox: 'textbox text "Roadmap" font-size LARGE x 0 y -100 {}',
    stamp: "stamp kind LIKE x 200 y 300 {}",
    connector: 'connector from "kick" to "valid" {}',
    waypoint: "waypoint [300 0]",
    section: 'section [ sticky text "A" {} ] name "Phase 1" {}',
    page: 'page [ sticky text "A" {} ] name "Planning" {}',
    board: 'board [ page [ sticky text "A" {} ] {} ] {}',
  })[word] ?? `${word} … {}`;

const owners = (table: Record<string, string[]>): Record<string, string[]> =>
  Object.entries(table).reduce((acc: Record<string, string[]>, [container, words]) => {
    for (const w of words) (acc[w] = acc[w] || []).push(container);
    return acc;
  }, {});
const attributeOwners = owners(validAttributes);
const settingOwners = owners(validSettings);
const memberOwners = owners(containerMembers);

/** Where `save-to-figjam` goes, for every error that finds it somewhere else. */
export const SAVE_HINT =
  ' `save-to-figjam` is a statement on its own line at the top of the program, e.g. save-to-figjam "https://www.figma.com/board/ABC123/Name" then board [ … ] {}..';

const whereSetting = (w: string, c: string): string =>
  c === "board"
    ? ` \`${w}\` is a setting of the board: write it after the board's outer \`]\`, e.g. board [ … ] ${w} … {}.`
    : ` \`${w}\` is a setting of \`${c}\`: write it after the ${c}'s \`]\`, e.g. ${c} [ … ] ${w} … {}.`;

/** Where a misplaced word belongs, as a sentence to append to the error. */
export function hintFor(w: string, here: string): string {
  if (w === SAVE_TO_FIGJAM.word) return SAVE_HINT;
  const members = (memberOwners[w] || []).filter((o) => o !== here);
  if (members.length) {
    return ` \`${w}\` is a member of ${members.map((m) => `\`${m}\``).join(" or ")}: write it inside its \`[ … ]\`, e.g. ${members[0]} [ ${exampleOf(w)} ] {}.`;
  }
  const settings = (settingOwners[w] || []).filter((o) => o !== here);
  const attrs = (attributeOwners[w] || []).filter((o) => o !== here);
  if (settings.length && !attrs.length) return whereSetting(w, settings[0]);
  if (attrs.length) {
    const also = settings.length ? `, or a setting of ${settings.map((s) => `\`${s}\``).join(" or ")}` : "";
    return ` \`${w}\` describes ${attrs.map((o) => `${/^[aeiou]/.test(o) ? "an" : "a"} \`${o}\``).join(" or ")}${also}.`;
  }
  return "";
}

/**
 * Reject a word a description does not accept, naming the legal set and where the misplaced word
 * belongs. The generator is an LLM that reads this and tries again, so the wording is a product
 * surface, not a diagnostic.
 */
export function assertKnownAttributes(kind: string, attrs: Record<string, any>, where = kind): void {
  const allowed = validAttributes[kind];
  const unknown = Object.keys(attrs).map(sourceWord).filter((w) => !allowed.includes(w));
  if (!unknown.length) return;
  const w = unknown[0];
  throw new Error(`${where}: \`${w}\` is not part of ${kind}. It takes: ${allowed.join(", ")}.${hintFor(w, kind)}`);
}

/** The same check for a settings chain. */
export function assertKnownSettings(container: string, settings: Record<string, any>, where = container): void {
  const allowed = validSettings[container];
  const unknown = Object.keys(settings).map(sourceWord).filter((w) => !allowed.includes(w));
  if (!unknown.length) return;
  const w = unknown[0];
  const takes = allowed.length ? `Its settings are: ${allowed.join(", ")}.` : "It takes no settings: write `{}`.";
  throw new Error(`${where}: \`${w}\` is not a setting of ${container}. ${takes}${hintFor(w, container)}`);
}
