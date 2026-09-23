// SPDX-License-Identifier: MIT
/**
 * L0183's lexicon = L0000's base vocabulary + L0183's words.
 *
 * Attribute and setting words are generated from the tables in `attributes.ts`, so their arity
 * can never disagree with the handlers generated from the same rows. Only the three containers
 * and the two theme tags are declared by hand.
 *
 * `mergeLexicon` throws at import if one of these shadows a base word without being declared
 * an override.
 */
import { lexicon as base, mergeLexicon } from "@graffiticode/l0000";
import { attributeFields, configFields, typeOf, wordOf } from "./attributes.js";

const fn = (name: string, arity: 1 | 2, type: string, description: string) => ({
  tk: 1,
  name,
  cls: "function",
  arity,
  type,
  description,
});

/** A tag value, written bare: `theme DARK`. */
const tag = (description: string) => ({
  tk: 22,
  name: "TAG",
  cls: "val",
  arity: 0,
  type: "<: tag>",
  description,
});

const words = (table: typeof attributeFields, arity: 1 | 2) =>
  Object.fromEntries(
    Object.entries(table).map(([name, meta]) => [
      wordOf(name),
      fn(name, arity, typeOf(meta, arity), meta.description),
    ]),
  );

/**
 * The containers. Each is arity 2 — its list AND its configuration record — because each
 * needs that second argument role (`console/docs/language-authoring-style.md` §2).
 */
const containers = {
  "concept-web": fn(
    "CONCEPT_WEB",
    2,
    "<list record: record>",
    "The program: an attribute list describing the diagram (hub, nodes, edges), then its settings (title, instructions, theme) ending in a record.",
  ),
  nodes: fn(
    "NODES",
    2,
    "<list record: record>",
    "The nodes around the hub, one attribute list each, then the node tray's settings (distractors, tray) ending in a record.",
  ),
  edges: fn(
    "EDGES",
    2,
    "<list record: record>",
    "The lines between nodes, one attribute list each, then the label tray's settings (distractors, tray) ending in a record. Without `edges`, every node gets a line from the hub.",
  ),
};

export const lexicon = mergeLexicon(
  base,
  {
    ...words(attributeFields, 1),
    ...words(configFields, 2),
    ...containers,
    DARK: tag("The dark theme."),
    LIGHT: tag("The light theme."),
  },
  { langID: "L0183" },
);
