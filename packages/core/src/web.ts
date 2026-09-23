// SPDX-License-Identifier: MIT
/**
 * Assembling a concept web: ids, edge references, blanks, trays, pools — and every error those
 * produce. The compiler hands this the merged attribute lists; nothing here walks an AST.
 *
 * The output is shaped for `@graffiticode/learnosity-cqt`'s cell-scoring contract, so the same
 * compiled model drives the /form view and a Learnosity custom question:
 *
 * - `interaction.cells` has one entry per blank, keyed by the blank's id. The learner's answer
 *   lives there as `value`, which is where cqt's `mergeResponse` folds a stored response.
 * - `validation.cells` holds the answer key per blank, and `validation.points` the total. The
 *   key is kept out of `interaction` so a graded delivery can withhold it.
 */
import { assertKnownAttributes, mergeAttributes, showValue } from "./attributes.js";

export interface WebNode {
  id: string;
  text?: string;
  shape?: string;
  color?: string;
  size?: string;
  /** Present on a blank: the learner fills it from the tray. */
  blank?: true;
}

export interface WebEdge {
  id: string;
  from: string;
  to: string;
  style: string;
  label?: string;
  blank?: true;
}

export interface TrayItem {
  id: string;
  text: string;
}

export interface Tray {
  items: TrayItem[];
  align: string;
}

export interface CellKey {
  assess: { expected: string; points: number };
  /** Blanks sharing a pool accept each other's answers — see `assignPools`. */
  pool: string;
}

export interface Compiled {
  title?: string;
  instructions?: string;
  theme?: string;
  interaction: {
    type: "concept-web";
    hub: WebNode;
    nodes: WebNode[];
    edges: WebEdge[];
    trays: { nodes?: Tray; edges?: Tray };
    cells: Record<string, { value?: string }>;
  };
  validation: {
    points: number;
    cells: Record<string, CellKey>;
  };
}

/** A member list's children and settings, as the compiler hands them over. */
export interface Members {
  items: any[];
  settings: Record<string, any>;
}

export const HUB_ID = "hub";

const NODE_EXAMPLE = '[text "Nucleus"]';
const EDGE_EXAMPLE = '[from "hub" to "Nucleus" label "contains"]';
const ASSESS_EXAMPLE = '[expected "Nucleus"]';

/** Read `assess [...]`, returning the key for one blank. */
function readAssess(raw: any, where: string): { expected: string; points: number } {
  const a = mergeAttributes(raw, `${where}: assess`, ASSESS_EXAMPLE);
  assertKnownAttributes("assess", a, `${where}: assess`);
  if (a.expected === undefined) {
    throw new Error(
      `${where}: assess needs \`expected\`, the correct answer, e.g. assess [expected "Nucleus"].`,
    );
  }
  const points = a.points ?? 1;
  if (!(points > 0)) {
    throw new Error(`${where}: assess \`points\` must be above 0, got ${showValue(points)}.`);
  }
  return { expected: a.expected, points };
}

/**
 * One node (or the hub). A node with `assess` is a blank: it shows nothing until the learner
 * fills it, so it may not also carry `text` — L0169 let a graded node carry its own answer as
 * its text, and every such node rendered already correct before the learner did anything.
 */
function readNode(
  attrs: Record<string, any>,
  where: string,
): { node: Omit<WebNode, "id"> & { id?: string }; key?: { expected: string; points: number } } {
  const { assess, ...rest } = attrs;
  if (assess === undefined) {
    if (rest.text === undefined) {
      throw new Error(
        `${where}: needs \`text\`, or \`assess\` to make it a blank, e.g. [text "Nucleus"] or [id "n" assess [expected "Nucleus"]].`,
      );
    }
    return { node: rest };
  }
  if (rest.text !== undefined) {
    throw new Error(
      `${where}: has both \`text\` and \`assess\`. A blank shows nothing until the learner fills it — ` +
        `drop \`text\`, and give it an \`id\` if an edge needs to refer to it.`,
    );
  }
  return { node: { ...rest, blank: true }, key: readAssess(assess, where) };
}

/**
 * Resolve an edge endpoint: a node's id first, then its exact text. A reference that names
 * nothing, or names two nodes, is an error — L0169 dropped such an edge without a word.
 */
function resolveRef(ref: string, nodes: WebNode[], where: string, word: string): string {
  const byId = nodes.find((n) => n.id === ref);
  if (byId) return byId.id;
  const byText = nodes.filter((n) => n.text === ref);
  if (byText.length === 1) return byText[0].id;
  if (byText.length > 1) {
    throw new Error(
      `${where}: \`${word} ${JSON.stringify(ref)}\` matches ${byText.length} nodes with that text. ` +
        `Give the one you mean an \`id\` and refer to it by that.`,
    );
  }
  const known = nodes.map((n) => (n.text !== undefined ? `${n.id} (${JSON.stringify(n.text)})` : n.id));
  throw new Error(
    `${where}: \`${word} ${JSON.stringify(ref)}\` names no node. Refer to a node by its id or its exact text. ` +
      `The nodes are: ${known.join(", ")}.`,
  );
}

/**
 * Pools: which blanks accept each other's answers.
 *
 * Two blanks whose places in the web are indistinguishable — same kind, and the same edges to
 * the same neighbours, drawn the same way with the same labels — cannot be told apart by the
 * learner, so an answer key that insists on one arrangement of them marks a correct web wrong.
 * Such blanks share a pool, and the scorer matches answers across the pool as a whole.
 *
 * This is L0169's runtime `edgeSignature`, moved to compile time so the scorer stays trivial
 * and runs anywhere Learnosity runs it, including server-side.
 */
function assignPools(
  hub: WebNode,
  edges: WebEdge[],
  keyed: string[],
): Record<string, string> {
  const edgeSide = (e: WebEdge, dir: string, other: string) =>
    [dir, e.style, e.blank ? `?${e.id}` : (e.label ?? ""), other].join("|");
  const signature = (id: string): string => {
    const edge = edges.find((e) => e.id === id);
    if (edge) return ["edge", edge.from, edge.to, edge.style].join("|");
    const kind = id === hub.id ? "hub" : "node";
    const sides = edges
      .flatMap((e) =>
        e.from === id ? [edgeSide(e, "out", e.to)] : e.to === id ? [edgeSide(e, "in", e.from)] : [],
      )
      .sort();
    return [kind, ...sides].join("\n");
  };
  const pools: Record<string, string> = {};
  const bySignature = new Map<string, string>();
  for (const id of keyed) {
    const sig = signature(id);
    if (!bySignature.has(sig)) bySignature.set(sig, `p${bySignature.size + 1}`);
    pools[id] = bySignature.get(sig)!;
  }
  return pools;
}

/** A tray: every answer the blanks expect, plus the distractors. Shuffled by the view. */
function buildTray(
  answers: string[],
  settings: Record<string, any>,
  prefix: string,
  container: string,
  defaultAlign: string,
): Tray | undefined {
  const distractors: string[] = settings.distractors || [];
  const clash = distractors.find((d) => answers.includes(d));
  if (clash !== undefined) {
    throw new Error(
      `${container}: distractor ${JSON.stringify(clash)} is also a correct answer. A distractor must be wrong — drop it from \`distractors\`.`,
    );
  }
  if (!answers.length) {
    if (distractors.length) {
      throw new Error(
        `${container}: has \`distractors\` but no blanks. Distractors join a tray of answers — ` +
          `give at least one ${container === "nodes" ? "node" : "edge"} an \`assess\`.`,
      );
    }
    return undefined;
  }
  const texts = [...answers, ...distractors];
  return {
    items: texts.map((text, i) => ({ id: `${prefix}${i + 1}`, text })),
    align: settings.tray || defaultAlign,
  };
}

/**
 * Build the compiled model from `concept-web`'s merged attribute list and its settings.
 *
 * `data` is the learner's state carried back on a recompile. Exactly one thing is taken from it:
 * each blank's `value`. Everything else comes from this compile, so a stale model can never
 * shadow a fresh one.
 */
export function buildWeb(
  web: Record<string, any>,
  settings: Record<string, any>,
  data?: any,
): Compiled {
  if (web.hub === undefined) {
    throw new Error(
      'concept-web: needs a `hub`, the node at the centre, e.g. concept-web [ hub [text "The Cell"] nodes [ … ] {} ] {}.',
    );
  }
  if (web.nodes === undefined) {
    throw new Error(
      'concept-web: needs `nodes`, the nodes around the hub, e.g. nodes [ [text "Nucleus"] [text "Ribosome"] ] {}.',
    );
  }
  const keys: Record<string, { expected: string; points: number }> = {};

  // The hub.
  const hubAttrs = mergeAttributes(web.hub, "hub", NODE_EXAMPLE);
  assertKnownAttributes("hub", hubAttrs);
  const hubRead = readNode(hubAttrs, "hub");
  const hub: WebNode = { id: HUB_ID, ...hubRead.node };
  if (hubRead.key) keys[HUB_ID] = hubRead.key;

  // Nodes: ids are the author's, else n1, n2, … by position.
  const nodeMembers: Members = web.nodes;
  if (!nodeMembers.items.length) {
    throw new Error('nodes: needs at least one node, e.g. nodes [ [text "Nucleus"] ] {}.');
  }
  const nodes: WebNode[] = nodeMembers.items.map((entry, i) => {
    const where = `node ${i + 1}`;
    const attrs = mergeAttributes(entry, where, NODE_EXAMPLE);
    assertKnownAttributes("node", attrs, where);
    const { node, key } = readNode(attrs, where);
    const id = node.id ?? `n${i + 1}`;
    if (key) keys[id] = key;
    return { id, ...node };
  });
  const seen = new Set<string>([HUB_ID]);
  for (const n of nodes) {
    if (seen.has(n.id)) {
      throw new Error(
        n.id === HUB_ID
          ? 'nodes: the id "hub" is taken by the hub. Give this node another id.'
          : `nodes: two nodes have the id ${JSON.stringify(n.id)}. Every id must be different.`,
      );
    }
    seen.add(n.id);
  }
  const all = [hub, ...nodes];

  // Edges: given, or a spoke from the hub to every node.
  let edges: WebEdge[];
  const edgeMembers: Members | undefined = web.edges;
  if (edgeMembers === undefined) {
    edges = nodes.map((n, i) => ({ id: `e${i + 1}`, from: HUB_ID, to: n.id, style: "solid" }));
  } else {
    edges = edgeMembers.items.map((entry, i) => {
      const where = `edge ${i + 1}`;
      const attrs = mergeAttributes(entry, where, EDGE_EXAMPLE);
      assertKnownAttributes("edge", attrs, where);
      const { assess, from, to, ...rest } = attrs;
      if (from === undefined || to === undefined) {
        throw new Error(
          `${where}: needs both \`from\` and \`to\`, e.g. ${EDGE_EXAMPLE}.`,
        );
      }
      const edge: WebEdge = {
        id: rest.id ?? `e${i + 1}`,
        from: resolveRef(from, all, where, "from"),
        to: resolveRef(to, all, where, "to"),
        style: rest.style ?? "solid",
        ...(rest.label !== undefined ? { label: rest.label } : {}),
      };
      if (edge.from === edge.to) {
        throw new Error(`${where}: goes from a node to itself. An edge joins two different nodes.`);
      }
      if (assess !== undefined) {
        if (edge.label !== undefined) {
          throw new Error(
            `${where}: has both \`label\` and \`assess\`. A blank edge shows no label until the learner fills it — drop \`label\`.`,
          );
        }
        edge.blank = true;
        keys[edge.id] = readAssess(assess, where);
      }
      return edge;
    });
    const edgeIds = new Set<string>();
    for (const e of edges) {
      if (edgeIds.has(e.id) || seen.has(e.id)) {
        throw new Error(
          `edges: the id ${JSON.stringify(e.id)} is used twice. Every node and edge id must be different.`,
        );
      }
      edgeIds.add(e.id);
    }
  }

  // Trays and the answer key.
  const nodeBlanks = all.filter((n) => n.blank).map((n) => n.id);
  const edgeBlanks = edges.filter((e) => e.blank).map((e) => e.id);
  const nodeTray = buildTray(
    nodeBlanks.map((id) => keys[id].expected),
    nodeMembers.settings,
    "c",
    "nodes",
    "right",
  );
  const edgeTray = buildTray(
    edgeBlanks.map((id) => keys[id].expected),
    edgeMembers?.settings || {},
    "r",
    "edges",
    "bottom",
  );
  const blanks = [...nodeBlanks, ...edgeBlanks];
  const pools = assignPools(hub, edges, blanks);

  const answered = data?.interaction?.cells || {};
  const cells: Record<string, { value?: string }> = {};
  const keyCells: Record<string, CellKey> = {};
  let points = 0;
  for (const id of blanks) {
    const value = answered[id]?.value;
    cells[id] = typeof value === "string" ? { value } : {};
    keyCells[id] = { assess: keys[id], pool: pools[id] };
    points += keys[id].points;
  }

  return {
    ...(settings.title !== undefined ? { title: settings.title } : {}),
    ...(settings.instructions !== undefined ? { instructions: settings.instructions } : {}),
    ...(settings.theme !== undefined ? { theme: settings.theme } : {}),
    interaction: {
      type: "concept-web",
      hub,
      nodes,
      edges,
      trays: {
        ...(nodeTray ? { nodes: nodeTray } : {}),
        ...(edgeTray ? { edges: edgeTray } : {}),
      },
      cells,
    },
    validation: { points, cells: keyCells },
  };
}
