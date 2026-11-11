// SPDX-License-Identifier: MIT
/**
 * Which ring each node sits on, and at what angle. Pure, tested without a DOM.
 *
 * Up to SINGLE_RING nodes keep L0183's original picture: one ring in author order, the first at
 * the top and the rest clockwise. Past that, nodes go on concentric rings.
 *
 * Graph distance from the hub decides only the ORDER in which nodes fill the rings, never how
 * many rings there are: rings are filled inside out, each to the number of nodes its
 * circumference holds, so the ring count grows like √n and a long chain wraps around instead of
 * getting a ring per link.
 */

export const SINGLE_RING = 12;

export interface RingEdge {
  from: string;
  to: string;
}

export interface Slot {
  id: string;
  /** 1-based; the hub is ring 0. */
  ring: number;
  angle: number;
}

export interface RingPlan {
  slots: Slot[];
  /** Node count per ring, index 0 = ring 1. */
  counts: number[];
  /** Each ring's closed-form lower-bound radius: clear of the ring inside, neighbours apart. */
  radii: number[];
}

const TOP = -Math.PI / 2;
const TAU = 2 * Math.PI;

/**
 * How many nodes fit on a ring of radius `r` when neighbours, `2·hd + gap` apart at least, must
 * not touch.
 */
export function capacity(r: number, hd: number, gap: number): number {
  const s = (2 * hd + gap) / (2 * r);
  if (s >= 1) return 1;
  return Math.max(1, Math.floor(Math.PI / Math.asin(s)));
}

/** The smallest radius at which m nodes on a ring are a chord of 2·hd + gap apart. */
export function chordRadius(m: number, hd: number, gap: number): number {
  return m > 1 ? (2 * hd + gap) / (2 * Math.sin(Math.PI / m)) : 0;
}

/** Breadth-first distance from the hub over edges in either direction; unreachable is Infinity. */
export function distances(hub: string, ids: string[], edges: RingEdge[]): Map<string, number> {
  const adj = new Map<string, string[]>();
  for (const id of [hub, ...ids]) adj.set(id, []);
  for (const e of edges) {
    adj.get(e.from)?.push(e.to);
    adj.get(e.to)?.push(e.from);
  }
  const dist = new Map<string, number>(ids.map((id) => [id, Infinity]));
  dist.set(hub, 0);
  const queue = [hub];
  while (queue.length) {
    const u = queue.shift()!;
    for (const v of adj.get(u) || []) {
      if (dist.get(v) === Infinity) {
        dist.set(v, dist.get(u)! + 1);
        queue.push(v);
      }
    }
  }
  return dist;
}

function circularMean(angles: number[]): number {
  const sx = angles.reduce((s, a) => s + Math.cos(a), 0);
  const sy = angles.reduce((s, a) => s + Math.sin(a), 0);
  return Math.atan2(sy, sx);
}

function angDist(a: number, b: number): number {
  const d = Math.abs(a - b) % TAU;
  return d > Math.PI ? TAU - d : d;
}

/**
 * Assign every node a ring and an angle.
 *
 * @param hubHd the hub's half-diagonal
 * @param hd    the largest ring node's half-diagonal (every ring is sized for it)
 */
export function assignRings(
  hub: string,
  ids: string[],
  edges: RingEdge[],
  hubHd: number,
  hd: number,
  gap: number,
): RingPlan {
  const n = ids.length;
  const first = hubHd + hd + gap;
  if (n <= SINGLE_RING) {
    return {
      slots: ids.map((id, i) => ({ id, ring: 1, angle: TOP + (TAU * i) / n })),
      counts: n ? [n] : [],
      radii: n ? [Math.ceil(Math.max(first, chordRadius(n, hd, gap)))] : [],
    };
  }

  const dist = distances(hub, ids, edges);
  const order = ids
    .map((id, i) => ({ id, i, d: dist.get(id)! }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.id);

  // Ring 1 holds every hub neighbour, however many, so no spoke has to cross a ring. The rest
  // fill rings inside out, each to its capacity: graph distance orders them but does not decide
  // how many rings there are.
  const near = order.filter((id) => dist.get(id) === 1).length;
  const rings: string[][] = [];
  const radii: number[] = [];
  let k = 0;
  while (k < order.length) {
    let r = rings.length === 0 ? first : radii[radii.length - 1] + 2 * hd + gap;
    let cap = capacity(r, hd, gap);
    if (rings.length === 0 && near > cap) {
      r = chordRadius(near, hd, gap);
      cap = Math.max(near, capacity(r, hd, gap));
    }
    const members = order.slice(k, k + cap);
    rings.push(members);
    radii.push(Math.ceil(Math.max(r, chordRadius(members.length, hd, gap))));
    k += cap;
  }

  const neighbours = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    neighbours.get(e.from)?.push(e.to);
    neighbours.get(e.to)?.push(e.from);
  }

  const angleOf = new Map<string, number>();
  const slots: Slot[] = [];
  rings.forEach((members, ri) => {
    const m = members.length;
    const pitch = TAU / m;
    const offset = TOP + (ri % 2 === 1 ? pitch / 2 : 0);
    const slotAngles = Array.from({ length: m }, (_, j) => offset + j * pitch);

    let ordered = members;
    if (ri > 0) {
      // Where each node would like to be: the mean angle of its neighbours already placed on
      // inner rings, or else of a neighbour on this ring that already has a wish, so a chain
      // that runs along the ring keeps running along it.
      const wish = new Map<string, number>();
      for (const id of members) {
        const placed = (neighbours.get(id) || []).filter((v) => angleOf.has(v)).map((v) => angleOf.get(v)!);
        if (placed.length) wish.set(id, circularMean(placed));
      }
      let progress = true;
      while (progress) {
        progress = false;
        for (const id of members) {
          if (wish.has(id)) continue;
          const near = (neighbours.get(id) || []).find((v) => wish.has(v) && members.includes(v));
          if (near !== undefined) {
            wish.set(id, wish.get(near)! + pitch);
            progress = true;
          }
        }
      }
      const norm = (a: number) => ((a - TOP) % TAU + TAU) % TAU;
      // Nodes with no wish keep their fill order, after the rest.
      ordered = [...members].sort((a, b) => {
        const wa = wish.has(a) ? norm(wish.get(a)!) : Infinity;
        const wb = wish.has(b) ? norm(wish.get(b)!) : Infinity;
        return wa - wb || members.indexOf(a) - members.indexOf(b);
      });
      // Rotate the sequence onto the slots to best meet the wishes.
      let bestShift = 0;
      let bestCost = Infinity;
      for (let s = 0; s < m; s++) {
        let cost = 0;
        ordered.forEach((id, j) => {
          if (wish.has(id)) cost += angDist(wish.get(id)!, slotAngles[(j + s) % m]);
        });
        if (cost < bestCost - 1e-9) {
          bestCost = cost;
          bestShift = s;
        }
      }
      const shifted: string[] = new Array(m);
      ordered.forEach((id, j) => (shifted[(j + bestShift) % m] = id));
      ordered = shifted;
    }
    ordered.forEach((id, j) => {
      angleOf.set(id, slotAngles[j]);
      slots.push({ id, ring: ri + 1, angle: slotAngles[j] });
    });
  });

  // Keep the caller's node order.
  const byId = new Map(slots.map((s) => [s.id, s]));
  return { slots: ids.map((id) => byId.get(id)!), counts: rings.map((r) => r.length), radii };
}
