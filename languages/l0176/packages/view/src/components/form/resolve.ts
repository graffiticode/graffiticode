// SPDX-License-Identifier: MIT
// Dynamic data, resolved in the browser before signing. Ported from L0158's
// View (l0158 packages/app/lib/view.jsx: pickRow, resolveVariables,
// applyDynamicData).
//
// Learnosity substitutes {{var:X}} in the standard fields it owns the schema
// for (stimulus, options, ...), but passes custom-question `data` through
// opaque: a custom question whose widget data holds {{var:A1}} reaches the
// widget unsubstituted. So the Form picks one row of the activity's
// `dynamic_content_data` per mount and substitutes it everywhere, custom data
// included, and only then has the resolved activity signed. A signature
// covers exactly what is rendered.

const isPlainObject = (v: any): boolean => v !== null && typeof v === "object" && !Array.isArray(v);

export type Env = Record<string, unknown>;

/** One row of a `{ cols, rows: { id: { values } } }` table, as `{ col: value }`, or null. */
export function pickRow(dcd: any, random: () => number = Math.random): Env | null {
  if (!isPlainObject(dcd) || !Array.isArray(dcd.cols)) return null;
  const rows = isPlainObject(dcd.rows) ? dcd.rows : {};
  const rowIds = Object.keys(rows);
  if (rowIds.length === 0) return null;
  const row = rows[rowIds[Math.floor(random() * rowIds.length)]];
  if (!row || !Array.isArray(row.values)) return null;
  return dcd.cols.reduce((env: Env, col: string, i: number) => {
    env[col] = row.values[i];
    return env;
  }, {});
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Substitutes every `{{var:X}}` in every string of `val`, at any depth. */
export function resolveVariables(val: any, env: Env): any {
  if (typeof val === "string") {
    let out = val;
    for (const key of Object.keys(env)) {
      out = out.replace(new RegExp(`\\{\\{var:${escapeRegExp(key)}\\}\\}`, "g"), () => String(env[key]));
    }
    return out;
  }
  if (Array.isArray(val)) return val.map((item) => resolveVariables(item, env));
  if (isPlainObject(val)) {
    const acc: Record<string, any> = {};
    for (const key of Object.keys(val)) acc[key] = resolveVariables(val[key], env);
    return acc;
  }
  return val;
}

/** A Learnosity activity: `{ type: "questions" | "items", data: {...} }`. */
export const isActivity = (val: any): boolean =>
  isPlainObject(val) && (val.type === "questions" || val.type === "items") && isPlainObject(val.data);

/**
 * A key for an activity's content: what it renders, not the per-compile
 * envelope (`request`, `signing`, and the `id`/`session_id` a compile may
 * mint afresh). The Form resolves and signs once per key.
 */
export function activityKey(activity: any): string {
  const { id: _id, session_id: _session, ...content } = activity?.data ?? {};
  return JSON.stringify([activity?.type ?? null, content]);
}
