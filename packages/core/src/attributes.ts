// SPDX-License-Identifier: MIT
/**
 * The vocabulary as data.
 *
 * Adding a word is a row in this file: the lexicon entry, the Checker method and the
 * Transformer method are all generated from it, arity included, so a word can never be
 * declared with one arity and handled with another. Never hand-write a word's handler.
 *
 * The style is `console/docs/language-authoring-style.md`. Everything that describes one thing
 * is a CHAIN: each word takes its value and the rest of the chain, and the chain ends in a
 * record, so `text "Nucleus" color "blue" {}` computes `{text: "Nucleus", color: "blue"}`.
 * That is how a node, an edge and the hub are described, and how every settings record is built.
 *
 * A MEMBER list is homogeneous and typed — `nodes [ node text "A" {} node text "B" {} ] {}` —
 * and the container takes the list AND its own settings chain. `concept-web` is the same shape:
 * a list of its children (`hub`, `nodes`, `edges`), then the program's settings.
 *
 * The one bracket list left inside a description is `assess [...]`, which takes the flags
 * `expected` or `distractor` and an optional `points`.
 */

/** Closed sets. Each is checked in the Transformer and named in the error when violated. */
export const SHAPES = ["rounded", "rect", "pill", "circle"] as const;
export const COLORS = [
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "green",
  "teal",
  "blue",
  "indigo",
  "purple",
  "pink",
] as const;
export const SIZES = ["small", "medium", "large"] as const;
export const EDGE_STYLES = ["solid", "dashed", "solid-arrow", "dashed-arrow"] as const;
/** Written as bare lowercase tags: `tray-align left`. */
export const TRAY_ALIGNS = ["right", "left", "top", "bottom"] as const;
export const THEMES = ["DARK", "LIGHT"] as const;

/** How a value is turned into the field it emits. */
export interface AttributeMeta {
  /** The key this word emits. */
  field: string;
  /**
   * The value's type, asserted in the Transformer — never the Checker, see `checkValue`.
   *
   * `text` is a string, or a number written for convenience (`text 42`), emitted as a string.
   * `list` is a bracket list, merged and checked by whatever reads it. `record` is a chain
   * ending in `{}`. `tag` is a bare tag from `oneOf` (`theme DARK`). `flag` takes no value.
   */
  expects: "text" | "number" | "list" | "record" | "tag" | "flag";
  /** Closed set of legal values. */
  oneOf?: readonly string[];
  /** One line, shown in the generated spec. */
  description: string;
}

/**
 * Arity 2: the chain words. Each takes its value AND the rest of the chain, and returns the
 * chain's record with its own key added. Where each may appear is `validAttributes` (the
 * descriptions) and `validSettings` (the settings records).
 */
export const chainFields: Record<string, AttributeMeta> = {
  ID: {
    field: "id",
    expects: "text",
    description:
      "A name for a node or edge, so an edge can refer to it. Defaults to n1, n2, … for nodes and e1, e2, … for edges.",
  },
  TEXT: {
    field: "text",
    expects: "text",
    description:
      "What a node shows. $…$ spans render as math, and a text that is just an image URL renders as the image. On a blank it is the answer, hidden until the learner fills it.",
  },
  SHAPE: {
    field: "shape",
    expects: "text",
    oneOf: SHAPES,
    description: `A node's outline: ${SHAPES.join(", ")}. Defaults to rounded.`,
  },
  COLOR: {
    field: "color",
    expects: "text",
    oneOf: COLORS,
    description: `A node's colour: ${COLORS.join(", ")}. Defaults to a neutral fill.`,
  },
  SIZE: {
    field: "size",
    expects: "text",
    oneOf: SIZES,
    description: `A node's size: ${SIZES.join(", ")}. The hub defaults to large, other nodes to medium.`,
  },
  FROM: {
    field: "from",
    expects: "text",
    description:
      'Where an edge starts: a node\'s id, or its exact text. The hub is "hub" or its text.',
  },
  TO: {
    field: "to",
    expects: "text",
    description: "Where an edge ends: a node's id, or its exact text.",
  },
  LABEL: {
    field: "label",
    expects: "text",
    description:
      "The words on an edge, naming the relationship. On a blank edge it is the answer, hidden until the learner fills it.",
  },
  STYLE: {
    field: "style",
    expects: "text",
    oneOf: EDGE_STYLES,
    description: `How an edge is drawn: ${EDGE_STYLES.join(", ")}. Defaults to solid.`,
  },
  ASSESS: {
    field: "assess",
    expects: "list",
    description:
      'Scores a node or edge: assess [expected] makes it a blank whose answer is its own text or label; assess [distractor points -1] makes it a wrong answer that sits only in the tray.',
  },
  TITLE: {
    field: "title",
    expects: "text",
    description: "The heading shown above the web.",
  },
  INSTRUCTIONS: {
    field: "instructions",
    expects: "text",
    description: "Guidance shown under the title.",
  },
  THEME: {
    field: "theme",
    expects: "tag",
    oneOf: THEMES,
    description: "The colour scheme, DARK or LIGHT, written as a bare tag. Defaults to LIGHT.",
  },
  TRAY_ALIGN: {
    field: "trayAlign",
    expects: "tag",
    oneOf: TRAY_ALIGNS,
    description: `Where a tray sits beside the web, written as a bare tag: ${TRAY_ALIGNS.join(", ")}. The node tray defaults to right, the label tray to bottom.`,
  },
};

/** Arity 1: the typed members. Each takes a chain and returns `{[word]: record}`. */
export const memberFields: Record<string, AttributeMeta> = {
  HUB: {
    field: "hub",
    expects: "record",
    description:
      'The node at the centre of the web, e.g. hub text "The Cell" {}. Every other node sits on a circle around it. Its id is always `hub`.',
  },
  NODE: {
    field: "node",
    expects: "record",
    description: 'One node around the hub, described by a chain ending in {}, e.g. node text "Nucleus" {}.',
  },
  EDGE: {
    field: "edge",
    expects: "record",
    description:
      'One line between nodes, described by a chain ending in {}, e.g. edge from "hub" to "Nucleus" label "contains" {}.',
  },
};

/** The words of an `assess [...]` list: arity 1 (`points`) and arity 0 (the flags). */
export const assessFields: Record<string, AttributeMeta> = {
  EXPECTED: {
    field: "expected",
    expects: "flag",
    description:
      "Makes a node or edge a blank. Its own text (or label) is the answer, and joins the tray.",
  },
  DISTRACTOR: {
    field: "distractor",
    expects: "flag",
    description:
      "Makes a node or edge a wrong answer: its text (or label) joins the tray, and it is not drawn in the web.",
  },
  POINTS: {
    field: "points",
    expects: "number",
    description:
      "What a blank is worth when filled correctly (above 0, default 1), or what a distractor costs when dropped on a blank (0 or below, default 0).",
  },
};

/**
 * Which words each description accepts, in source spelling.
 *
 * The highest-value check in the language, and the reason it is maintained by hand: a chain
 * builds whatever record it is handed, so a word written in the wrong chain lands in a record
 * nothing reads, compiles clean, and silently does nothing.
 */
export const validAttributes: Record<string, string[]> = {
  "concept-web": ["hub", "nodes", "edges"],
  hub: ["text", "shape", "color", "size", "assess"],
  node: ["id", "text", "shape", "color", "size", "assess"],
  edge: ["id", "from", "to", "label", "style", "assess"],
  assess: ["expected", "distractor", "points"],
};

/** Which chain words each settings record accepts. */
export const validSettings: Record<string, string[]> = {
  "concept-web": ["title", "instructions", "theme"],
  nodes: ["tray-align"],
  edges: ["tray-align"],
};

export const wordOf = (name: string): string => name.toLowerCase().replace(/_/g, "-");

/** The source word that emits `field`, for error messages (`trayAlign` is `tray-align`). */
const wordByField: Record<string, string> = Object.fromEntries(
  Object.entries({ ...chainFields, ...memberFields, ...assessFields }).map(([name, meta]) => [
    meta.field,
    wordOf(name),
  ]),
);
export const sourceWord = (field: string): string => wordByField[field] ?? field;

/** The signature string the generated spec renders, derived so it cannot drift from the row. */
export const typeOf = (meta: AttributeMeta, arity: 0 | 1 | 2): string => {
  const arg =
    meta.expects === "list"
      ? "list"
      : meta.expects === "record"
        ? "record"
        : meta.expects === "number"
          ? "number"
          : meta.expects === "tag"
            ? "tag"
            : "string";
  if (arity === 0) return "<: record>";
  return arity === 1 ? `<${arg}: record>` : `<${arg} record: record>`;
};

/**
 * Unwrap L0000's internal Record representation to plain JS.
 *
 * A `{...}` literal reaching a Transformer is `{_type: "record", _entries: Map}` with keys
 * encoded `tag:`/`str:`/`num:`. L0000 does not export a reader for it, so every child
 * language carries this. Dot-access without it silently misses.
 */
export function toPlainObject(val: any): any {
  if (
    val !== null &&
    typeof val === "object" &&
    val._type === "record" &&
    val._entries instanceof Map
  ) {
    const obj: any = {};
    for (const [k, v] of val._entries) {
      obj[(k as string).replace(/^(tag|str|num):/, "")] = toPlainObject(v);
    }
    return obj;
  }
  if (Array.isArray(val)) return val.map(toPlainObject);
  return val;
}

/** A value as it was written, for an error message. */
export function showValue(v: any): string {
  if (v === undefined) return "nothing";
  if (typeof v === "string") return JSON.stringify(v);
  if (isTag(v)) return `the tag ${v.tag}`;
  if (Array.isArray(v)) return "a list";
  if (v !== null && typeof v === "object") return "a record";
  return String(v);
}

/** A bare tag (`DARK`) reaches the Transformer as `{tag: "DARK"}`. */
export const isTag = (v: any): boolean =>
  v !== null && typeof v === "object" && !Array.isArray(v) && typeof v.tag === "string";

export const isRecord = (v: any): boolean =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !isTag(v);

/**
 * Check and normalize a value. Returns `{value}` or `{error}`.
 *
 * This runs in the TRANSFORMER, not the Checker, and that is not a style preference:
 * `Checker.LIST` visits only `elts[0]`, so a rule written as a Checker method fires on the
 * first element of a list and nowhere else.
 */
export function checkValue(
  name: string,
  meta: AttributeMeta,
  raw: any,
): { value?: any; error?: string } {
  const word = wordOf(name);
  switch (meta.expects) {
    case "text": {
      if (typeof raw === "number" && Number.isFinite(raw)) raw = String(raw);
      if (typeof raw !== "string") {
        return { error: `${word}: expected a string in "quotes", got ${showValue(raw)}.` };
      }
      if (meta.oneOf && !meta.oneOf.includes(raw)) {
        return {
          error: `${word}: ${showValue(raw)} is not one of ${meta.oneOf.map((v) => `"${v}"`).join(", ")}.`,
        };
      }
      if (!meta.oneOf && !raw.trim() && name !== "TEXT" && name !== "LABEL") {
        return { error: `${word}: must not be empty.` };
      }
      return { value: raw };
    }
    case "number":
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return { error: `${word}: expected a number, got ${showValue(raw)}.` };
      }
      return { value: raw };
    case "tag": {
      if (isTag(raw) && (!meta.oneOf || meta.oneOf.includes(raw.tag))) {
        return { value: raw.tag.toLowerCase() };
      }
      const legal = (meta.oneOf || []).join(" or ");
      const bare =
        typeof raw === "string"
          ? meta.oneOf?.find((v) => v.toLowerCase() === raw.toLowerCase())
          : undefined;
      const quoted = bare ? ` Write it bare, without quotes: ${word} ${bare}.` : "";
      return { error: `${word}: expected the tag ${legal}, got ${showValue(raw)}.${quoted}` };
    }
    case "list":
      if (!Array.isArray(raw)) {
        return {
          error: `${word}: expected a list in [brackets], e.g. ${word} [expected], got ${showValue(raw)}.`,
        };
      }
      return { value: raw };
    case "record":
      if (!isRecord(raw)) {
        return {
          error: `${word}: expected a description ending in \`{}\`, e.g. ${memberExample(word)}, got ${showValue(raw)}.`,
        };
      }
      return { value: raw };
    case "flag":
      return { value: true };
  }
}

/** A member written the way it should be, for error messages. */
export const memberExample = (word: string): string =>
  word === "edge"
    ? 'edge from "hub" to "Nucleus" label "contains" {}'
    : word === "hub"
      ? 'hub text "The Cell" {}'
      : 'node text "Nucleus" {}';

/** Every description a word can be written in, for the "belongs in" hint. */
const attributeOwners: Record<string, string[]> = Object.entries(validAttributes).reduce(
  (acc: Record<string, string[]>, [container, words]) => {
    for (const w of words) (acc[w] = acc[w] || []).push(container);
    return acc;
  },
  {},
);
const settingOwners: Record<string, string[]> = Object.entries(validSettings).reduce(
  (acc: Record<string, string[]>, [container, words]) => {
    for (const w of words) (acc[w] = acc[w] || []).push(container);
    return acc;
  },
  {},
);
/** Which list each typed member goes in. */
const memberOwners: Record<string, string> = { node: "nodes", edge: "edges" };

/** An example of a setting written where it belongs. */
const settingExample = (word: string, owner: string): string => {
  const value =
    word === "theme" ? "DARK" : word === "tray-align" ? (owner === "edges" ? "bottom" : "left") : '"…"';
  return `${owner} [ … ] ${word} ${value} {}`;
};

/** Where a misplaced word belongs, as a sentence to append to the error. */
function hintFor(w: string, container: string): string {
  if (memberOwners[w]) {
    return ` \`${w}\` is a member of \`${memberOwners[w]}\`, e.g. ${memberOwners[w]} [ ${memberExample(w)} ] {}.`;
  }
  // Not filtered by `container`: a setting is never unknown to its own settings record, so an
  // owner equal to `container` means it was written among that container's children instead.
  const settings = settingOwners[w] || [];
  if (settings.length) {
    return ` \`${w}\` is a setting and goes after the \`]\` of ${settings[0]}, e.g. ${settingExample(w, settings[0])}.`;
  }
  const owners = (attributeOwners[w] || []).filter((o) => o !== container);
  if (!owners.length) return "";
  if (owners.includes("assess")) {
    const eg = w === "points" ? "assess [expected points 2]" : `assess [${w}]`;
    return ` \`${w}\` belongs inside \`assess [ … ]\`, e.g. ${eg}.`;
  }
  return ` \`${w}\` belongs in ${owners.map((o) => `\`${o}\``).join(" or ")}.`;
}

/**
 * Fold a bracket list of single-key records into one object. A malformed entry is a compile
 * error, never a silent drop — a dropped entry is indistinguishable from one that did nothing.
 */
export function mergeAttributes(attrs: any, where: string, example: string): Record<string, any> {
  if (!Array.isArray(attrs)) {
    throw new Error(`${where}: expected a list in [brackets], e.g. ${example}.`);
  }
  const out: Record<string, any> = {};
  for (const a of attrs) {
    if (!isRecord(a)) {
      throw new Error(`${where}: every entry must be a word of the list, e.g. ${example}. Got ${showValue(a)}.`);
    }
    for (const k of Object.keys(a)) {
      if (Object.prototype.hasOwnProperty.call(out, k)) {
        throw new Error(`${where}: \`${sourceWord(k)}\` is given twice. Each may appear once.`);
      }
      out[k] = a[k];
    }
  }
  return out;
}

/**
 * Reject a word a description does not accept, naming the legal set and — the half that
 * actually fixes the program — where the misplaced word belongs.
 *
 * The generator is an LLM that reads this message and tries again, so the wording is a
 * product surface, not a diagnostic.
 */
export function assertKnownAttributes(
  container: string,
  attrs: Record<string, any>,
  where = container,
): void {
  const allowed = validAttributes[container];
  const unknown = Object.keys(attrs).map(sourceWord).filter((w) => !allowed.includes(w));
  if (!unknown.length) return;
  const w = unknown[0];
  throw new Error(
    `${where}: \`${w}\` is not part of ${container}. It takes: ${allowed.join(", ")}.${hintFor(w, container)}`,
  );
}

/** The same check for a settings record. */
export function assertKnownSettings(container: string, settings: Record<string, any>): void {
  const allowed = validSettings[container];
  const unknown = Object.keys(settings).map(sourceWord).filter((w) => !allowed.includes(w));
  if (!unknown.length) return;
  const w = unknown[0];
  throw new Error(
    `${container}: \`${w}\` is not a setting of ${container}. Its settings are: ${allowed.join(", ")}.${hintFor(w, container)}`,
  );
}
