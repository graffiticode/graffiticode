// SPDX-License-Identifier: MIT
/**
 * Board assembly, over plain objects: typed members become the nodes the FigJam plugin draws,
 * pages get their names, and every connector endpoint is resolved against its page.
 *
 * The output contract is the plugin's (`figma-plugin/src/code.ts`): `{type: "board", pages:
 * [{name, nodes}]}`, where each node carries exactly the fields the plugin reads. Only fields the
 * program wrote are emitted; sizes and colours left out take FigJam's defaults when drawn.
 */
import { STAMP_KINDS, SHAPE_KINDS, exampleOf } from "./attributes.js";

export interface Page {
  name: string;
  background?: string;
  nodes: any[];
}

export interface Board {
  type: "board";
  title?: string;
  showPageTabs: boolean;
  showPageMenu: boolean;
  pages: Page[];
  fileKey?: string;
}

/* ------------------------------------------------------------------ save-to-figjam */

const FIGMA_URL = /figma\.com\/(?:board|design|file)\/([A-Za-z0-9]+)/;
const BARE_KEY = /^[A-Za-z0-9]{6,}$/;

/** A FigJam file key from a bare key or a figma.com board/design/file link. */
export function parseFileKey(input: any): string {
  if (typeof input === "string") {
    const s = input.trim();
    const m = s.match(FIGMA_URL);
    if (m) return m[1];
    if (BARE_KEY.test(s)) return s;
  }
  throw new Error(
    `save-to-figjam: expected a FigJam link like "https://www.figma.com/board/ABC123/Name" or a bare file key like "ABC123", got ${
      typeof input === "string" ? JSON.stringify(input) : "something else"
    }.`,
  );
}

/* ------------------------------------------------------------------ nodes */

/** A typed member's record, as the node the plugin draws. `type` comes first, like L0172's. */
export function toNode(member: string, rec: any, where: string): any {
  switch (member) {
    case "sticky":
      return { type: "sticky", ...rec };
    case "textbox":
      return { type: "text", ...rec };
    case "shape": {
      const { kind, ...rest } = rec;
      if (kind !== undefined && !(SHAPE_KINDS as readonly string[]).includes(kind)) {
        throw new Error(`${where}: kind ${kind} is a stamp, not a shape. A shape's kind is one of ${SHAPE_KINDS.join(", ")}.`);
      }
      return { type: "shape", shapeType: kind ?? "SQUARE", ...rest };
    }
    case "stamp": {
      const { kind, ...rest } = rec;
      if (kind === undefined) throw new Error(`${where}: needs a kind, one of ${STAMP_KINDS.join(", ")}, e.g. ${exampleOf("stamp")}.`);
      if (!(STAMP_KINDS as readonly string[]).includes(kind)) {
        throw new Error(`${where}: kind ${kind} is a shape, not a stamp. A stamp's kind is one of ${STAMP_KINDS.join(", ")}.`);
      }
      return { type: "stamp", stamp: kind.toLowerCase(), ...rest };
    }
    case "connector":
      for (const end of ["from", "to"]) {
        if (rec[end] === undefined) throw new Error(`${where}: needs both from and to, e.g. ${exampleOf("connector")}.`);
      }
      // FigJam refuses a CENTER magnet on elbowed and curved connectors.
      for (const [field, word] of [["fromSide", "from-side"], ["toSide", "to-side"]]) {
        if (rec[field] === "center" && rec.lineType !== "straight") {
          const type = (rec.lineType ?? "elbowed").toUpperCase();
          throw new Error(
            `${where}: ${word} CENTER needs line-type STRAIGHT; FigJam cannot attach ${type === "ELBOWED" ? "an" : "a"} ${type} connector at a node's centre. Use AUTO, TOP, BOTTOM, LEFT or RIGHT, or add line-type STRAIGHT.`,
          );
        }
      }
      if (rec.waypoints !== undefined &&[rec.from, rec.to].some((e) => Array.isArray(e) || e === "*")) {
        throw new Error(
          `${where}: waypoints route one line: give a single from and a single to, e.g. connector from "a" to "b" waypoints [ waypoint [300 0] ] {}.`,
        );
      }
      return { type: "connector", ...rec };
  }
  throw new Error(`${where}: unknown member ${member}.`);
}

/** A node's description in errors: `sticky "kick"`, or `sticky 3` when it has no key. */
export const nodeName = (member: string, rec: any, i: number): string => {
  const key = rec.id ?? (member === "section" ? rec.name : rec.text);
  return `${member} ${key !== undefined && key !== "" ? JSON.stringify(key) : i + 1}`;
};

/**
 * The key the plugin registers a drawn node under, mirroring its `primaryKey`: shapes, stickies
 * and text by id, falling back to text; stamps by their reaction. Plugins before the L0186 release
 * never register a section that holds nodes, so naming a section stays an error here until every
 * user has the plugin that does (figma-plugin `l0186-pages`); `"*"` may still reach one there.
 */
export function primaryKey(n: any): string | null {
  if (n.type === "shape" || n.type === "sticky" || n.type === "text") {
    if (n.id != null) return String(n.id);
    return n.text != null ? String(n.text) : null;
  }
  if (n.type === "stamp") return String(n.stamp);
  return null;
}

/** Every node on a page, in drawing order, sections' contents in place (as the plugin walks them). */
export function walk(nodes: any[], visit: (n: any) => void): void {
  for (const n of nodes) {
    if (n.type === "section") {
      visit(n);
      walk(n.nodes, visit);
    } else visit(n);
  }
}

/* ------------------------------------------------------------------ pages */

const quoteList = (keys: string[]): string => {
  const shown = keys.slice(0, 12).map((k) => JSON.stringify(k));
  return shown.join(", ") + (keys.length > 12 ? `, … (${keys.length} in all)` : "");
};

/**
 * Check a page's keys and connectors. Ids are unique on a page; every endpoint names a node the
 * plugin will register on the same page, or is "*". The checks run over the whole board so an
 * endpoint that names a node on another page says which.
 */
function checkPage(page: Page, pageWhere: string, others: Page[]): void {
  const ids = new Map<string, string>();
  const keys = new Map<string, number>();
  const sectionNames = new Set<string>();
  walk(page.nodes, (n) => {
    if (n.id != null) {
      const id = String(n.id);
      if (ids.has(id)) throw new Error(`${pageWhere}: two nodes have the id ${JSON.stringify(id)}. Ids must be unique on a page.`);
      ids.set(id, n.type);
    }
    if (n.type === "section" && n.name != null) sectionNames.add(String(n.name));
    const k = primaryKey(n);
    if (k != null) keys.set(k, (keys.get(k) ?? 0) + 1);
  });
  const known = [...keys.keys()];
  walk(page.nodes, (n) => {
    if (n.type !== "connector") return;
    for (const end of ["from", "to"]) {
      const names: string[] = Array.isArray(n[end]) ? n[end] : [n[end]];
      for (const name of names) {
        if (name === "*") continue;
        const count = keys.get(name) ?? 0;
        const where = `${pageWhere}: connector ${end} ${JSON.stringify(name)}`;
        if (count > 1 && !ids.has(name)) {
          throw new Error(`${where}: ${count} nodes say ${JSON.stringify(name)}, so it could mean any of them. Give the one you mean an id, e.g. sticky id "a" text ${JSON.stringify(name)} {}, and connect to "a".`);
        }
        if (count) continue;
        if (sectionNames.has(name)) {
          throw new Error(`${where}: names a section, and a connector cannot attach to a section yet. Connect to a node inside it.`);
        }
        const elsewhere = others.find((p) => {
          let found = false;
          walk(p.nodes, (m) => (found ||= primaryKey(m) === name));
          return found;
        });
        if (elsewhere) {
          throw new Error(`${where}: that node is on page ${JSON.stringify(elsewhere.name)}. A connector joins nodes on its own page.`);
        }
        throw new Error(
          `${where}: no node on this page has that id or text.${known.length ? ` It has: ${quoteList(known)}.` : " The page has no nodes to connect."}`,
        );
      }
    }
  });
}

/* ------------------------------------------------------------------ board */

/** Name the pages, apply the tab defaults, and check every page's connectors. */
export function buildBoard(pages: { nodes: any[]; settings: any }[], settings: any): Board {
  if (!pages.length) throw new Error(`board: needs at least one page, e.g. ${exampleOf("board")}.`);
  const named: Page[] = pages.map(({ nodes, settings: s }, i) => {
    if (s.name === undefined && pages.length > 1) {
      throw new Error(`board: page ${i + 1} needs a name — a board with more than one page names every page, e.g. page [ … ] name "Retro" {}.`);
    }
    const page: Page = { name: s.name ?? "Page 1", nodes };
    if (s.background !== undefined) page.background = s.background;
    return page;
  });
  const seen = new Set<string>();
  for (const p of named) {
    if (seen.has(p.name)) throw new Error(`board: two pages are named ${JSON.stringify(p.name)}. Page names must be unique.`);
    seen.add(p.name);
  }
  named.forEach((p) =>
    checkPage(
      p,
      `page ${JSON.stringify(p.name)}`,
      named.filter((o) => o !== p),
    ),
  );
  const showPageTabs = settings.showPageTabs ?? named.length > 1;
  const showPageMenu = settings.showPageMenu ?? false;
  if (named.length > 1 && !showPageTabs && !showPageMenu) {
    throw new Error("board: show-page-tabs false hides every page but the first. Keep the tabs, or add show-page-menu true.");
  }
  const board: Board = { type: "board", showPageTabs, showPageMenu, pages: named };
  if (settings.title !== undefined) board.title = settings.title;
  return board;
}
