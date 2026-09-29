// SPDX-License-Identifier: MIT
//
// Lowers the legacy save member to the explicit save function, BEFORE any
// checking or permission admission sees the program:
//
//   items [save-to-itembank true, item [...]] {}   →   save-to-itembank items [item [...]] {}
//   questions [save-to-itembank true, mcq []] {}    →   save-to-itembank questions [mcq []] {}
//
// Only the literal form is lowered: a SAVE_TO_ITEMBANK whose argument is a
// BOOL node, written directly in the list of an ITEMS or QUESTIONS node.
// `save-to-itembank false` is simply removed. Anything else that sets the flag
// (a record assembled by another expression) is left alone and refused by
// ITEMS/QUESTIONS, so the only node that can write is SAVE_TO_ITEMBANK wrapping
// an activity — the node permission admission sees and the write happens in.
//
// The input pool is not mutated; rewritten nodes get fresh nids, so nodes the
// parser shares between several parents are never edited in place.

const LEAF_TAGS = new Set(["NUM", "STR", "IDENT", "BOOL", "TAG", "NULL"]);

export function lowerLegacySave(code: any): any {
  if (!code || typeof code !== "object") {
    return code;
  }
  const pool = structuredClone(code);
  const keys = Object.keys(pool).filter((k) => k !== "root");
  let next = Math.max(0, ...keys.map(Number).filter(Number.isFinite)) + 1;
  const replace = new Map<number, number>();
  const orphans: number[] = [];

  for (const key of keys) {
    const node = pool[key];
    if (node?.tag !== "ITEMS" && node?.tag !== "QUESTIONS") continue;
    const listNid = node.elts?.[0];
    const list = pool[listNid];
    if (list?.tag !== "LIST") continue;
    const saveNids = list.elts.filter((nid: number) => {
      const member = pool[nid];
      return member?.tag === "SAVE_TO_ITEMBANK" && pool[member.elts?.[0]]?.tag === "BOOL";
    });
    if (saveNids.length === 0) continue;
    // Members merge last-wins, so the last literal decides.
    const last = pool[saveNids[saveNids.length - 1]];
    const save = pool[last.elts[0]].elts[0] === true;

    const newListNid = next++;
    pool[newListNid] = { tag: "LIST", elts: list.elts.filter((nid: number) => !saveNids.includes(nid)) };
    const activityNid = next++;
    pool[activityNid] = { ...node, elts: [newListNid, ...node.elts.slice(1)] };
    if (save) {
      const wrapperNid = next++;
      pool[wrapperNid] = { tag: "SAVE_TO_ITEMBANK", elts: [activityNid], ...(last.coord ? { coord: last.coord } : {}) };
      replace.set(Number(key), wrapperNid);
    } else {
      replace.set(Number(key), activityNid);
    }
    orphans.push(Number(key), listNid, ...saveNids);
  }
  if (replace.size === 0) {
    return code;
  }
  for (const key of Object.keys(pool)) {
    if (key === "root") continue;
    const node = pool[key];
    if (!node || LEAF_TAGS.has(node.tag) || !Array.isArray(node.elts)) continue;
    node.elts = node.elts.map((e: any) => (typeof e === "number" && replace.has(e) ? replace.get(e) : e));
  }
  if (replace.has(pool.root)) {
    pool.root = replace.get(pool.root);
  }
  // Drop the replaced nodes (and the legacy members) once nothing reachable
  // from the root refers to them, so the member form never remains in the pool.
  const reachable = new Set<number>();
  const stack = [pool.root];
  while (stack.length > 0) {
    const nid = stack.pop();
    if (typeof nid !== "number" || reachable.has(nid)) continue;
    reachable.add(nid);
    const node = pool[nid];
    if (node && !LEAF_TAGS.has(node.tag) && Array.isArray(node.elts)) {
      node.elts.forEach((e: any) => typeof e === "number" && stack.push(e));
    }
  }
  for (const nid of orphans) {
    if (reachable.has(nid)) continue;
    const member = pool[nid];
    const arg = member?.tag === "SAVE_TO_ITEMBANK" ? member.elts?.[0] : undefined;
    delete pool[nid];
    if (typeof arg === "number" && !reachable.has(arg) && pool[arg]?.tag === "BOOL") {
      delete pool[arg];
    }
  }
  return pool;
}
