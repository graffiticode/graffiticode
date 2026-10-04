// SPDX-License-Identifier: MIT
/** Field access and the did-you-mean for unknown fields. */

/** A field by exact key first, then as a dot-path into nested records. */
export function getPath(row: any, field: string): any {
  if (row === null || typeof row !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(row, field)) return row[field];
  if (!field.includes(".")) return undefined;
  let cur: any = row;
  for (const part of field.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

/** The fields of the first records, in first-seen order. */
export function fieldsOf(data: any[], sample = 1000): string[] {
  const seen = new Set<string>();
  for (const row of data.slice(0, sample)) {
    if (row && typeof row === "object" && !Array.isArray(row)) for (const k of Object.keys(row)) seen.add(k);
  }
  return [...seen];
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

/** The closest known field within two edits, if any. */
export function didYouMean(name: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestD = 3;
  for (const c of candidates) {
    const d = distance(name.toLowerCase(), c.toLowerCase());
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/** Dot-paths to the values nested in records (not lists), down to `depth` levels. */
function nestedPaths(row: any, prefix = "", depth = 3): string[] {
  if (!row || typeof row !== "object" || Array.isArray(row) || depth === 0) return [];
  return Object.entries(row).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === "object" && !Array.isArray(v) ? [path, ...nestedPaths(v, path, depth - 1)] : [path];
  });
}

/**
 * The nested path a top-level name was probably reaching for: "team" for a record holding
 * {player: {name, team}} is "player.team". Matches the last segment, exactly or within two edits.
 */
function nestedMatch(field: string, data: any[]): string | undefined {
  const lastOf = (p: string) => p.split(".").pop()!;
  const nested = nestedPaths(data[0]).filter((p) => p.includes("."));
  const exact = nested.find((p) => lastOf(p) === lastOf(field));
  if (exact) return exact;
  const near = didYouMean(lastOf(field), nested.map(lastOf));
  return near === undefined ? undefined : nested.find((p) => lastOf(p) === near);
}

/**
 * Throw if a field names nothing in the data. Empty data is not checked — there is nothing to
 * check against, and an empty result is a legitimate one.
 */
export function assertField(word: string, field: string, data: any[]): void {
  if (!data.length) return;
  if (data.slice(0, 1000).some((r) => getPath(r, field) !== undefined)) return;
  const fields = fieldsOf(data);
  const guess = didYouMean(field, fields) ?? nestedMatch(field, data);
  const list = fields.slice(0, 20).map((f) => JSON.stringify(f)).join(", ");
  throw new Error(
    `${word}: no field ${JSON.stringify(field)} in the data. Its fields are: ${list}${fields.length > 20 ? ", …" : ""}.` +
      (guess ? ` Did you mean ${JSON.stringify(guess)}?` : ""),
  );
}
