// SPDX-License-Identifier: MIT
/**
 * What a tray shows. Pure, tested without a DOM.
 *
 * The compiler emits a tray in authored order — answers first, then distractors — so it must
 * be shuffled, and shuffling belongs HERE, at render, never in the compiler: every placement
 * recompiles, and a compile-time shuffle would reorder the tray under the learner's hand.
 */

export interface TrayItem {
  id: string;
  text: string;
}

/** A small deterministic PRNG, so a tray's order is stable across renders and reloads. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Shuffle seeded by the tray's own content: the same tray always comes out in the same order,
 * and the order does not give the answers away as the authored order would.
 */
export function shuffle<T extends TrayItem>(items: T[]): T[] {
  const rand = mulberry32(hash(items.map((i) => i.text).join("\u0000")));
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The items still in the tray: every item minus those already placed, as a multiset — a tray
 * holding "whale" twice still offers the second after the first is placed.
 */
export function available<T extends TrayItem>(items: T[], placed: (string | undefined)[]): T[] {
  const used = new Map<string, number>();
  for (const v of placed) if (v) used.set(v, (used.get(v) || 0) + 1);
  return items.filter((item) => {
    const n = used.get(item.text) || 0;
    if (n > 0) {
      used.set(item.text, n - 1);
      return false;
    }
    return true;
  });
}
