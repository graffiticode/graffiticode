// SPDX-License-Identifier: MIT
/**
 * The vocabulary as data.
 *
 * Adding a word is a row in this file: the lexicon entry, the Checker method and the
 * Transformer method are all generated from it, arity included, so a word can never be
 * declared with one arity and handled with another. Never hand-write an attribute handler.
 *
 * The style is `console/docs/language-authoring-style.md`, and it has two kinds of list:
 *
 * - An ATTRIBUTE list is heterogeneous — different named properties, like an HTML element's
 *   attributes. Each word takes one argument and evaluates to a single-key record, and the
 *   enclosing word merges the list into one object: `[id "r" assess [expected "Receptor"]]`.
 * - A MEMBER list is homogeneous — children of one kind, like an element's child elements. The
 *   container word is arity 2 and takes the children AND its own configuration record:
 *   `nodes [ [text "A"] [text "B"] ] {}`. `{}` is the empty configuration, not a terminator.
 *
 * `concept-web` itself is arity 2 for the same reason: an attribute list describing the diagram,
 * then the program's configuration record.
 *
 * Configuration records are built by CHAINING, and that is the only place chaining happens. The
 * chaining words are the second table below, and it is deliberately small: each is a word the
 * generator must place outside the brackets, which is exactly the kind of thing it gets wrong.
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
export const TRAY_PLACEMENTS = ["right", "left", "top", "bottom"] as const;
export const THEMES = ["DARK", "LIGHT"] as const;

/** How a value is turned into the field it emits. */
export interface AttributeMeta {
  /** The key this word emits. */
  field: string;
  /**
   * The value's type, asserted in the Transformer — never the Checker, see `checkValue`.
   *
   * `text` is a string, or a number written for convenience (`text 42`), emitted as a string.
   * `object` is an attribute list, merged here and checked against `validAttributes` by the
   * word's own name. `tag` is a bare tag from `oneOf` (`theme DARK`).
   */
  expects: "text" | "number" | "texts" | "object" | "tag";
  /** Closed set of legal values. */
  oneOf?: readonly string[];
  /** One line, shown in the generated spec. */
  description: string;
}

/**
 * Arity 1: one row per attribute word. The key is the AST tag; the source spelling is the key
 * lowercased with underscores as dashes.
 */
export const attributeFields: Record<string, AttributeMeta> = {
  HUB: {
    field: "hub",
    expects: "object",
    description:
      'The node at the centre of the web, e.g. hub [text "The Cell"]. Every other node sits on a circle around it. Its id is always `hub`.',
  },
  ID: {
    field: "id",
    expects: "text",
    description:
      "A name for a node or edge, so an edge can refer to it. Needed for a blank node, which has no text to be referred to by. Defaults to n1, n2, … for nodes and e1, e2, … for edges.",
  },
  TEXT: {
    field: "text",
    expects: "text",
    description:
      "What a node shows. $…$ spans render as math, and a text that is just an image URL renders as the image. A node with `assess` is a blank and has no text.",
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
      "The words on an edge, naming the relationship. An edge with `assess` is a blank and has no label.",
  },
  STYLE: {
    field: "style",
    expects: "text",
    oneOf: EDGE_STYLES,
    description: `How an edge is drawn: ${EDGE_STYLES.join(", ")}. Defaults to solid.`,
  },
  ASSESS: {
    field: "assess",
    expects: "object",
    description:
      'Makes a node or edge a blank the learner fills by dragging from the tray, e.g. assess [expected "Nucleus"]. Its answer joins the tray automatically.',
  },
  EXPECTED: {
    field: "expected",
    expects: "text",
    description: "The correct answer for a blank, exactly as it appears in the tray.",
  },
  POINTS: {
    field: "points",
    expects: "number",
    description: "What a blank is worth when filled correctly. Defaults to 1; must be above 0.",
  },
};

/**
 * Arity 2: the chaining words, legal only in a configuration record.
 *
 * Each takes its value AND the rest of the chain, returning the chain's record with its own key
 * added, so `] title "…" theme DARK {}` computes the configuration record the container takes as
 * its second argument. Where each may appear is `validSettings`.
 */
export const configFields: Record<string, AttributeMeta> = {
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
  DISTRACTORS: {
    field: "distractors",
    expects: "texts",
    description:
      'Wrong answers added to a tray, e.g. nodes [ … ] distractors ["Golgi"] {}. The right answers are added for you.',
  },
  TRAY: {
    field: "tray",
    expects: "text",
    oneOf: TRAY_PLACEMENTS,
    description: `Where a tray sits beside the web: ${TRAY_PLACEMENTS.join(", ")}. The node tray defaults to right, the label tray to bottom.`,
  },
};

/**
 * Which attributes each attribute list accepts, in source spelling.
 *
 * The highest-value check in the language, and the reason it is maintained by hand: an
 * attribute list merges whatever it is handed, so a word written one level too high lands in
 * a record nothing reads, compiles clean, and silently does nothing.
 */
export const validAttributes: Record<string, string[]> = {
  "concept-web": ["hub", "nodes", "edges"],
  hub: ["text", "shape", "color", "size", "assess"],
  node: ["id", "text", "shape", "color", "size", "assess"],
  edge: ["id", "from", "to", "label", "style", "assess"],
  assess: ["expected", "points"],
};

/** Which chaining words each configuration record accepts. */
export const validSettings: Record<string, string[]> = {
  "concept-web": ["title", "instructions", "theme"],
  nodes: ["distractors", "tray"],
  edges: ["distractors", "tray"],
};

export const wordOf = (name: string): string => name.toLowerCase().replace(/_/g, "-");

/** The signature string the generated spec renders, derived so it cannot drift from the row. */
export const typeOf = (meta: AttributeMeta, arity: 1 | 2): string => {
  const arg =
    meta.expects === "object" || meta.expects === "texts"
      ? "list"
      : meta.expects === "number"
        ? "number"
        : meta.expects === "tag"
          ? "tag"
          : "string";
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

/**
 * Check and normalize a value. Returns `{value}` or `{error}`.
 *
 * This runs in the TRANSFORMER, not the Checker, and that is not a style preference:
 * `Checker.LIST` visits only `elts[0]`, so a rule written as a Checker method fires on the
 * first element of a list and nowhere else — in a style built on lists, almost nowhere.
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
    case "texts": {
      const example = `${word} ["Golgi" "Lysosome"]`;
      if (!Array.isArray(raw) || !raw.length) {
        return { error: `${word}: expected a list of strings, e.g. ${example}.` };
      }
      const out: string[] = [];
      for (let i = 0; i < raw.length; i++) {
        const v = typeof raw[i] === "number" ? String(raw[i]) : raw[i];
        if (typeof v !== "string" || !v.trim()) {
          return {
            error: `${word}: entry ${i + 1} is ${showValue(raw[i])}; every entry must be a string in "quotes", e.g. ${example}.`,
          };
        }
        out.push(v);
      }
      return { value: out };
    }
    case "tag": {
      if (isTag(raw) && (!meta.oneOf || meta.oneOf.includes(raw.tag))) {
        return { value: raw.tag.toLowerCase() };
      }
      const legal = (meta.oneOf || []).join(" or ");
      const quoted =
        typeof raw === "string" && meta.oneOf?.includes(raw.toUpperCase())
          ? ` Write it bare, without quotes: ${word} ${raw.toUpperCase()}.`
          : "";
      return { error: `${word}: expected the tag ${legal}, got ${showValue(raw)}.${quoted}` };
    }
    case "object":
      // Merged and checked by the container that owns the word, which knows its own name.
      return { value: raw };
  }
}

/** Every container and attribute a word can be written in, for the "belongs inside" hint. */
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

/** An example of a setting written where it belongs. */
const settingExample = (word: string, owner: string): string => {
  const value =
    word === "theme"
      ? "DARK"
      : word === "tray"
        ? '"left"'
        : word === "distractors"
          ? '["…"]'
          : '"…"';
  return `${owner} [ … ] ${word} ${value} {}`;
};

/**
 * Fold an attribute list into one object. A malformed entry is a compile error, never a
 * silent drop — a dropped attribute is indistinguishable from one that did nothing.
 */
export function mergeAttributes(attrs: any, where: string, example: string): Record<string, any> {
  if (!Array.isArray(attrs)) {
    throw new Error(`${where}: expected an attribute list in [brackets], e.g. ${example}.`);
  }
  const out: Record<string, any> = {};
  for (const a of attrs) {
    if (a === null || typeof a !== "object" || Array.isArray(a) || isTag(a)) {
      throw new Error(
        `${where}: every entry must be an attribute applied to a value, e.g. ${example}. ` +
          `Got ${showValue(a)}.`,
      );
    }
    for (const k of Object.keys(a)) {
      if (Object.prototype.hasOwnProperty.call(out, k)) {
        throw new Error(`${where}: \`${k}\` is given twice. Each attribute may appear once.`);
      }
      out[k] = a[k];
    }
  }
  return out;
}

/**
 * Reject a word an attribute list does not accept, naming the legal set and — the half that
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
  const unknown = Object.keys(attrs).filter((w) => !allowed.includes(w));
  if (!unknown.length) return;
  const w = unknown[0];
  let hint = "";
  if (settingOwners[w]) {
    const owner = settingOwners[w][0];
    hint = ` \`${w}\` is a setting and goes after the \`]\` of ${owner}, e.g. ${settingExample(w, owner)}.`;
  } else {
    const owners = (attributeOwners[w] || []).filter((o) => o !== container);
    if (owners.length) hint = ` \`${w}\` belongs inside ${owners.map((o) => `\`${o}\``).join(" or ")}.`;
  }
  throw new Error(
    `${where}: \`${w}\` is not an attribute of ${container}. It takes: ${allowed.join(", ")}.${hint}`,
  );
}

/** The same check for a configuration record. */
export function assertKnownSettings(container: string, settings: Record<string, any>): void {
  const allowed = validSettings[container];
  const unknown = Object.keys(settings).filter((w) => !allowed.includes(w));
  if (!unknown.length) return;
  const w = unknown[0];
  const owners = (settingOwners[w] || []).filter((o) => o !== container);
  const hint = owners.length
    ? ` \`${w}\` goes after the \`]\` of ${owners[0]}, e.g. ${settingExample(w, owners[0])}.`
    : attributeOwners[w]
      ? ` \`${w}\` is an attribute and belongs inside the brackets of ${attributeOwners[w].map((o) => `\`${o}\``).join(" or ")}.`
      : "";
  throw new Error(
    `${container}: \`${w}\` is not a setting of ${container}. Its settings are: ${allowed.join(", ")}.${hint}`,
  );
}
