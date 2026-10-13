// SPDX-License-Identifier: MIT
/**
 * L0183's lexicon = L0000's base vocabulary + L0183's words.
 *
 * Chain, member and assess words are generated from the tables in `attributes.ts`, so their
 * arity can never disagree with the handlers generated from the same rows. Only the three
 * containers and the tags are declared by hand.
 *
 * `mergeLexicon` throws at import if one of these shadows a base word without being declared
 * an override.
 */
import { lexicon as base, mergeLexicon } from "@graffiticode/l0000";
import {
  TRAY_ALIGNS,
  assessFields,
  chainFields,
  memberFields,
  typeOf,
  wordOf,
} from "./attributes.js";

const fn = (name: string, arity: 0 | 1 | 2, type: string, description: string) => ({
  tk: 1,
  name,
  cls: "function",
  arity,
  type,
  description,
});

/** A tag value, written bare: `theme DARK`, `tray-align left`. */
const tag = (description: string) => ({
  tk: 22,
  name: "TAG",
  cls: "val",
  arity: 0,
  type: "<: tag>",
  description,
});

const words = (table: typeof chainFields, arity: (expects: string) => 0 | 1 | 2) =>
  Object.fromEntries(
    Object.entries(table).map(([name, meta]) => [
      wordOf(name),
      fn(name, arity(meta.expects), typeOf(meta, arity(meta.expects)), meta.description),
    ]),
  );

/**
 * The containers. Each is arity 2 — its list AND its settings record — because each
 * needs that second argument role (`console/docs/language-style-typed-chains.md` §3).
 */
const containers = {
  "concept-web": fn(
    "CONCEPT_WEB",
    2,
    "<list record: record>",
    "The program: a list of its children (hub, nodes, edges), then its settings (title, instructions, theme) ending in a record.",
  ),
  nodes: fn(
    "NODES",
    2,
    "<list record: record>",
    "The nodes around the hub, each written node … {}, then the node tray's settings (tray-align) ending in a record.",
  ),
  edges: fn(
    "EDGES",
    2,
    "<list record: record>",
    "The lines between nodes, each written edge … {}, then the label tray's settings (tray-align) ending in a record. Without `edges`, every node gets a line from the hub.",
  ),
};

export const lexicon = mergeLexicon(
  base,
  {
    ...words(chainFields, () => 2),
    ...words(memberFields, () => 1),
    ...words(assessFields, (expects) => (expects === "flag" ? 0 : 1)),
    ...containers,
    DARK: tag("The dark theme."),
    LIGHT: tag("The light theme."),
    ...Object.fromEntries(TRAY_ALIGNS.map((a) => [a, tag(`Puts a tray on the ${a} of the web.`)])),
  },
  { langID: "L0183" },
);
