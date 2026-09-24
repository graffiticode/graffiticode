// SPDX-License-Identifier: MIT
/**
 * Assembling a concept web: ids, edge references, blanks, trays, pools — and every error those
 * produce. The compiler hands this the evaluated descriptions; nothing here walks an AST.
 *
 * The output is shaped for `@graffiticode/learnosity-cqt`'s cell-scoring contract, so the same
 * compiled model drives the /form view and a Learnosity custom question:
 *
 * - `interaction.cells` has one entry per blank, keyed by the blank's id. The learner's answer
 *   lives there as `value`, which is where cqt's `mergeResponse` folds a stored response.
 * - `validation.cells` holds the answer key per blank, and `validation.points` the total. The
 *   key is kept out of `interaction` so a graded delivery can withhold it — which is why a
 *   blank's own text or label is stripped from the drawn node or edge.
 * - `validation.distractors` holds what each distractor costs when dropped on a blank.
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
  /** The tray this blank is filled from, and so whose distractors it can be given. */
  tray: TrayKind;
}

export type TrayKind = "nodes" | "edges";

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
    /** Per tray, what each distractor scores when dropped on a blank (0 or below). */
    distractors?: { nodes?: Record<string, number>; edges?: Record<string, number> };
  };
}

/** A member list's descriptions and settings, as the compiler hands them over. */
export interface Members {
  items: Record<string, any>[];
  settings: Record<string, any>;
}

export const HUB_ID = "hub";

const NODE_EXAMPLE = 'node text "Nucleus" {}';
const BLANK_EXAMPLE = 'node text "Nucleus" assess [expected] {}';
const EDGE_EXAMPLE = 'edge from "hub" to "Nucleus" label "contains" {}';

/** What `assess [...]` says: a blank worth `points`, or a distractor costing `points`. */
interface Assess {
  kind: "expected" | "distractor";
  points: number;
}

/** Read `assess [...]`. */
function readAssess(raw: any, where: string): Assess {
  const a = mergeAttributes(raw, `${where}: assess`, "assess [expected]");
  assertKnownAttributes("assess", a, `${where}: assess`);
  if (a.expected && a.distractor) {
    throw new Error(
      `${where}: assess has both \`expected\` and \`distractor\`. A blank is filled with its own answer; a distractor is a wrong answer in the tray. Keep one.`,
    );
  }
  if (!a.expected && !a.distractor) {
    throw new Error(
      `${where}: assess needs \`expected\` (a blank, answered by its own text) or \`distractor\` (a wrong answer in the tray), e.g. assess [expected] or assess [distractor points -1].`,
    );
  }
  if (a.expected) {
    const points = a.points ?? 1;
    if (!(points > 0)) {
      throw new Error(
        `${where}: \`points\` on a blank must be above 0, got ${showValue(points)}. A negative \`points\` belongs on a distractor.`,
      );
    }
    return { kind: "expected", points };
  }
  const points = a.points ?? 0;
  if (!(points <= 0)) {
    throw new Error(
      `${where}: \`points\` on a distractor must be 0 or below — it is what dropping it on a blank costs. Got ${showValue(points)}.`,
    );
  }
  return { kind: "distractor", points };
}

/** A distractor is only a tray item, so every other word on it would silently do nothing. */
function assertDistractorOnly(attrs: Record<string, any>, answer: string, where: string): void {
  const extra = Object.keys(attrs).find((k) => k !== answer && k !== "assess");
  if (extra !== undefined) {
    throw new Error(
      `${where}: a distractor sits only in the tray and is not drawn, so it takes just \`${answer}\` and \`assess\` — drop \`${extra}\`.`,
    );
  }
}

type Read<T> =
  | { placed: T; text?: string; key?: { expected: string; points: number } }
  | { distractor: { text: string; points: number } };

/**
 * One node (or the hub). Every node has `text`. With `assess [expected]` it is a blank: the text
 * is its answer, moved into the key and stripped from the drawn node so it shows nothing until
 * the learner fills it. With `assess [distractor]` it is a wrong answer in the tray, not drawn.
 */
function readNode(
  attrs: Record<string, any>,
  where: string,
  example: string,
): Read<Omit<WebNode, "id"> & { id?: string }> {
  const { assess, ...rest } = attrs;
  if (rest.text === undefined) {
    throw new Error(`${where}: needs \`text\`, e.g. ${example}.`);
  }
  if (assess === undefined) return { placed: rest, text: rest.text };
  const a = readAssess(assess, where);
  if (!rest.text.trim()) {
    throw new Error(`${where}: an assessed node's \`text\` is its answer, so it must not be empty.`);
  }
  if (a.kind === "distractor") {
    assertDistractorOnly(attrs, "text", where);
    return { distractor: { text: rest.text, points: a.points } };
  }
  const { text, ...shown } = rest;
  return {
    placed: { ...shown, blank: true },
    text,
    key: { expected: text, points: a.points },
  };
}

/** A node as an edge can name it: by id, or by its text — a blank's too, though it is hidden. */
interface Ref {
  id: string;
  text?: string;
}

/**
 * Resolve an edge endpoint: a node's id first, then its exact text. A reference that names
 * nothing, or names two nodes, is an error — L0169 dropped such an edge without a word.
 */
function resolveRef(ref: string, nodes: Ref[], where: string, word: string): string {
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
      `The nodes are: ${known.join(", ")}. A distractor is not drawn and cannot be joined.`,
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
  distractors: { text: string; points: number }[],
  settings: Record<string, any>,
  prefix: string,
  container: TrayKind,
  defaultAlign: string,
): { tray?: Tray; costs?: Record<string, number> } {
  const member = container === "nodes" ? "node" : "edge";
  const costs: Record<string, number> = {};
  for (const d of distractors) {
    if (answers.includes(d.text)) {
      throw new Error(
        `${container}: distractor ${JSON.stringify(d.text)} is also a correct answer. A distractor must be wrong — change or drop it.`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(costs, d.text)) {
      throw new Error(`${container}: distractor ${JSON.stringify(d.text)} is given twice. Each may appear once.`);
    }
    costs[d.text] = d.points;
  }
  if (!answers.length) {
    if (distractors.length) {
      throw new Error(
        `${container}: has a distractor but no blanks. Distractors join a tray of answers — ` +
          `give at least one ${member} \`assess [expected]\`.`,
      );
    }
    return {};
  }
  const texts = [...answers, ...distractors.map((d) => d.text)];
  return {
    tray: {
      items: texts.map((text, i) => ({ id: `${prefix}${i + 1}`, text })),
      align: settings.trayAlign || defaultAlign,
    },
    ...(distractors.length ? { costs } : {}),
  };
}

/**
 * The learner's state as it reaches the compiler through the platform API: each layer of a
 * chained task is handed the previous layer's whole compile response, so the /form's model
 * arrives as L0000's `{data, errors}` envelope, and the envelope has been seen to nest after a
 * round trip. Unwrap until the model shows. The discriminator is `errors` being an array, as in
 * L0000's `unwrapEnvelopeData` — the envelope always carries one; a model never does.
 */
function unwrapEnvelope(value: any): any {
  while (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray(value.errors)
  ) {
    value = value.data;
  }
  return value;
}

/**
 * Build the compiled model from `concept-web`'s merged children and its settings.
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
      'concept-web: needs a `hub`, the node at the centre, e.g. concept-web [ hub text "The Cell" {} nodes [ … ] {} ] {}.',
    );
  }
  if (web.nodes === undefined) {
    throw new Error(
      'concept-web: needs `nodes`, the nodes around the hub, e.g. nodes [ node text "Nucleus" {} node text "Ribosome" {} ] {}.',
    );
  }
  const keys: Record<string, { expected: string; points: number }> = {};

  // The hub.
  assertKnownAttributes("hub", web.hub);
  const hubRead = readNode(web.hub, "hub", 'hub text "The Cell" {}');
  if ("distractor" in hubRead) {
    throw new Error("hub: cannot be a distractor — the hub is always drawn. Use assess [expected] to make it a blank.");
  }
  const hub: WebNode = { id: HUB_ID, ...hubRead.placed };
  if (hubRead.key) keys[HUB_ID] = hubRead.key;
  const refs: Ref[] = [{ id: HUB_ID, text: hubRead.text }];

  // Nodes: ids are the author's, else n1, n2, … counting the drawn nodes.
  const nodeMembers: Members = web.nodes;
  const nodes: WebNode[] = [];
  const nodeDistractors: { text: string; points: number }[] = [];
  nodeMembers.items.forEach((attrs, i) => {
    const where = `node ${i + 1}`;
    assertKnownAttributes("node", attrs, where);
    const read = readNode(attrs, where, i ? BLANK_EXAMPLE : NODE_EXAMPLE);
    if ("distractor" in read) {
      nodeDistractors.push(read.distractor);
      return;
    }
    const id = read.placed.id ?? `n${nodes.length + 1}`;
    if (read.key) keys[id] = read.key;
    nodes.push({ id, ...read.placed });
    refs.push({ id, text: read.text });
  });
  if (!nodes.length) {
    throw new Error(`nodes: needs at least one drawn node, e.g. nodes [ ${NODE_EXAMPLE} ] {}.`);
  }
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

  // Edges: given, or a spoke from the hub to every node.
  let edges: WebEdge[] = [];
  const edgeDistractors: { text: string; points: number }[] = [];
  const edgeMembers: Members | undefined = web.edges;
  if (edgeMembers === undefined) {
    edges = nodes.map((n, i) => ({ id: `e${i + 1}`, from: HUB_ID, to: n.id, style: "solid" }));
  } else {
    edgeMembers.items.forEach((attrs, i) => {
      const where = `edge ${i + 1}`;
      assertKnownAttributes("edge", attrs, where);
      const { assess, from, to, ...rest } = attrs;
      const a = assess === undefined ? undefined : readAssess(assess, where);
      if (a && rest.label === undefined) {
        throw new Error(
          `${where}: an assessed edge needs \`label\` — its answer, e.g. edge from "hub" to "Nucleus" label "contains" assess [expected] {}.`,
        );
      }
      if (a?.kind === "distractor") {
        assertDistractorOnly(attrs, "label", where);
        edgeDistractors.push({ text: rest.label, points: a.points });
        return;
      }
      if (from === undefined || to === undefined) {
        throw new Error(`${where}: needs both \`from\` and \`to\`, e.g. ${EDGE_EXAMPLE}.`);
      }
      const edge: WebEdge = {
        id: rest.id ?? `e${edges.length + 1}`,
        from: resolveRef(from, refs, where, "from"),
        to: resolveRef(to, refs, where, "to"),
        style: rest.style ?? "solid",
      };
      if (edge.from === edge.to) {
        throw new Error(`${where}: goes from a node to itself. An edge joins two different nodes.`);
      }
      if (a) {
        if (!rest.label.trim()) {
          throw new Error(`${where}: an assessed edge's \`label\` is its answer, so it must not be empty.`);
        }
        edge.blank = true;
        keys[edge.id] = { expected: rest.label, points: a.points };
      } else if (rest.label !== undefined) {
        edge.label = rest.label;
      }
      edges.push(edge);
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
  const all = [hub, ...nodes];
  const nodeBlanks = all.filter((n) => n.blank).map((n) => n.id);
  const edgeBlanks = edges.filter((e) => e.blank).map((e) => e.id);
  const nodeTray = buildTray(
    nodeBlanks.map((id) => keys[id].expected),
    nodeDistractors,
    nodeMembers.settings,
    "c",
    "nodes",
    "right",
  );
  const edgeTray = buildTray(
    edgeBlanks.map((id) => keys[id].expected),
    edgeDistractors,
    edgeMembers?.settings || {},
    "r",
    "edges",
    "bottom",
  );
  const trayOf: Record<string, TrayKind> = {};
  for (const id of nodeBlanks) trayOf[id] = "nodes";
  for (const id of edgeBlanks) trayOf[id] = "edges";
  const blanks = [...nodeBlanks, ...edgeBlanks];
  const pools = assignPools(hub, edges, blanks);

  const answered = unwrapEnvelope(data)?.interaction?.cells || {};
  const cells: Record<string, { value?: string }> = {};
  const keyCells: Record<string, CellKey> = {};
  let points = 0;
  for (const id of blanks) {
    const value = answered[id]?.value;
    cells[id] = typeof value === "string" ? { value } : {};
    keyCells[id] = { assess: keys[id], pool: pools[id], tray: trayOf[id] };
    points += keys[id].points;
  }
  const distractors = {
    ...(nodeTray.costs ? { nodes: nodeTray.costs } : {}),
    ...(edgeTray.costs ? { edges: edgeTray.costs } : {}),
  };

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
        ...(nodeTray.tray ? { nodes: nodeTray.tray } : {}),
        ...(edgeTray.tray ? { edges: edgeTray.tray } : {}),
      },
      cells,
    },
    validation: {
      points,
      cells: keyCells,
      ...(Object.keys(distractors).length ? { distractors } : {}),
    },
  };
}
