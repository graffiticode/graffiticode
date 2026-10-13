// SPDX-License-Identifier: MIT
/**
 * Datasets, resolved at compile time.
 *
 * A dataset is a table: an id, unique column names, and rectangular rows. A data property
 * (`values`, `names`, `categories`, `x`, `y`) takes either an inline list or a string naming a
 * column of the chart's selected dataset, and every column reference is resolved here, before
 * any plot's shape is checked. The output carries inline data only — never a `dataset` or
 * `encode` — so a bad reference is a compile error that names the column, not an empty chart.
 *
 * `normalizeRows` also accepts what an upstream hands us through `rows data use "0185"`: the
 * integer-keyed record L0000's `DATA` makes from an upstream array (`recordMerge`), `{}` when no
 * upstream is bound, or `{rows, columns?}`. Upstream rows are read leniently in one way: with
 * `columns` given, fields not named there are ignored rather than refused, because the upstream
 * is a separate program that may return more fields than the chart draws.
 */

export interface Dataset {
  id: string;
  columns: string[];
  rows: any[][];
}

export type Cell = string | number | boolean | null;

const isPlainRecord = (v: any): boolean => v !== null && typeof v === "object" && !Array.isArray(v);
const isCell = (v: any): boolean =>
  v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));

/**
 * An integer-keyed record (`{0: …, 1: …}`), as L0000's `DATA` produces from an upstream array,
 * back to an array. Keys must be exactly 0..n-1; they are taken in numeric order.
 */
export function fromIndexed(rec: Record<string, any>, where: string): any[] {
  const keys = Object.keys(rec);
  const nums = keys.map((k) => (/^(0|[1-9]\d*)$/.test(k) ? Number(k) : NaN));
  if (nums.some((n) => Number.isNaN(n))) {
    throw new Error(`${where}: expected a list of rows; got a record with keys ${keys.slice(0, 5).map((k) => JSON.stringify(k)).join(", ")}.`);
  }
  const sorted = [...nums].sort((a, b) => a - b);
  sorted.forEach((n, i) => {
    if (n !== i) throw new Error(`${where}: rows are numbered 0 to ${keys.length - 1} with a gap at ${i}.`);
  });
  return sorted.map((n) => rec[String(n)]);
}

/** Rows in any accepted shape → `{columns, rows}` with rectangular list rows. */
export function normalizeRows(raw: any, givenColumns: string[] | undefined, where: string): { columns: string[]; rows: any[][] } {
  let rows: any = raw;
  let columns = givenColumns;
  const fromUpstream = isPlainRecord(rows);
  if (isPlainRecord(rows) && Array.isArray(rows.rows)) {
    columns = columns ?? rows.columns;
    rows = rows.rows;
  } else if (isPlainRecord(rows)) {
    rows = fromIndexed(rows, where);
  }
  if (!Array.isArray(rows)) throw new Error(`${where}: rows must be a list in [brackets].`);
  if (fromUpstream && rows.length === 0 && !columns) {
    throw new Error(`${where}: its rows come from an upstream program and there are none yet, so name its columns: columns ["region" "revenue"] rows data use "0185".`);
  }
  if (columns !== undefined) checkColumns(columns, where);

  if (rows.every((r: any) => Array.isArray(r))) {
    if (!columns) {
      if (rows.length === 0) return { columns: [], rows: [] };
      throw new Error(`${where}: rows written as lists need \`columns\` to name them, e.g. columns ["month" "revenue"].`);
    }
    rows.forEach((r: any[], i: number) => {
      if (r.length !== columns!.length) {
        throw new Error(`${where}: row ${i + 1} has ${r.length} value${r.length === 1 ? "" : "s"}, but there are ${columns!.length} columns (${columns!.join(", ")}).`);
      }
      r.forEach((c, j) => checkCell(c, `${where} row ${i + 1}, column "${columns![j]}"`));
    });
    return { columns: columns!, rows };
  }

  if (rows.every((r: any) => isPlainRecord(r))) {
    const seen: string[] = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!seen.includes(k)) seen.push(k);
    const cols = columns ?? seen;
    const extra = fromUpstream ? [] : seen.filter((k) => !cols.includes(k));
    if (extra.length) throw new Error(`${where}: rows have the column "${extra[0]}", which is not in columns (${cols.join(", ")}).`);
    const out = rows.map((r: any, i: number) =>
      cols.map((c) => {
        if (!Object.prototype.hasOwnProperty.call(r, c)) {
          if (fromUpstream) {
            throw new Error(`${where}: the data from the upstream program has no field "${c}"; its fields are ${seen.map((k) => JSON.stringify(k)).join(", ")}. Name those in columns.`);
          }
          throw new Error(`${where}: row ${i + 1} has no "${c}". Every row needs every column; write null for a missing value.`);
        }
        checkCell(r[c], `${where} row ${i + 1}, column "${c}"`);
        return r[c];
      }),
    );
    return { columns: cols, rows: out };
  }

  throw new Error(`${where}: rows must all be lists (in column order) or all be records.`);
}

function checkColumns(columns: any, where: string): void {
  if (!Array.isArray(columns) || columns.some((c) => typeof c !== "string" || !c.trim())) {
    throw new Error(`${where}: columns must be a list of names in "quotes", e.g. columns ["month" "revenue"].`);
  }
  const dup = columns.find((c: string, i: number) => columns.indexOf(c) !== i);
  if (dup !== undefined) throw new Error(`${where}: the column "${dup}" is named twice. Column names must differ.`);
}

function checkCell(v: any, where: string): void {
  if (!isCell(v)) throw new Error(`${where}: a value must be a number, a string, true/false or null — got a list or a record.`);
}

/** A `dataset … {}` description → a Dataset, defaulting its id by position. */
export function normalizeDataset(rec: any, index: number, where: string): Dataset {
  if (rec.rows === undefined) throw new Error(`${where}: needs \`rows\`, e.g. dataset columns ["month" "revenue"] rows [["Jan" 120]] {}.`);
  const { columns, rows } = normalizeRows(rec.rows, rec.columns, where);
  return { id: rec.id ?? `d${index + 1}`, columns, rows };
}

/** Datasets in one scope, checked for duplicate ids after defaults resolve. */
export function scopeDatasets(recs: any[], scope: string): Map<string, Dataset> {
  const out = new Map<string, Dataset>();
  recs.forEach((rec, i) => {
    const ds = normalizeDataset(rec, i, `${scope} dataset ${rec.id ? JSON.stringify(rec.id) : i + 1}`);
    if (out.has(ds.id)) {
      throw new Error(`${scope}: two datasets have the id "${ds.id}". Give each dataset in one list its own id.`);
    }
    out.set(ds.id, ds);
  });
  return out;
}

/**
 * The dataset a chart's column names refer to. A chart-local dataset shadows a shared one with
 * the same id. `dataset-id` picks one; left out, the choice is made only when exactly one
 * dataset is visible. Returns null when none is selected — a column reference then fails.
 */
export function selectDataset(
  shared: Map<string, Dataset>,
  local: Map<string, Dataset>,
  datasetId: string | undefined,
  where: string,
): { selected: Dataset | null; visible: string[] } {
  const visible = new Map([...shared, ...local]);
  const ids = [...visible.keys()];
  if (datasetId !== undefined) {
    const ds = visible.get(datasetId);
    if (!ds) {
      throw new Error(
        `${where}: dataset-id "${datasetId}" names no dataset.${ids.length ? ` Datasets here: ${ids.map((i) => `"${i}"`).join(", ")}.` : " There are no datasets."}`,
      );
    }
    return { selected: ds, visible: ids };
  }
  return { selected: ids.length === 1 ? visible.get(ids[0])! : null, visible: ids };
}

/**
 * Resolve a data property: an inline list as written, or a column of the selected dataset.
 *
 * `shape` says what the property may hold. `flat` (the default) is a list of primitive cells.
 * `nested` is a list of lists of primitive cells — a BOXPLOT's per-category observations or a
 * HEATMAP's matrix — and can only be written inline: a column is always flat, so datasets use
 * the grouped or long forms instead (`values` + `group`, `x` + `y` + `values`).
 */
export function resolveData(
  value: any,
  prop: string,
  selected: Dataset | null,
  visible: string[],
  where: string,
  shape: "flat" | "nested" = "flat",
): { values: any[]; column?: string } {
  if (Array.isArray(value)) {
    if (shape === "nested") {
      value.forEach((row, i) => {
        if (!Array.isArray(row)) throw new Error(`${where}: ${prop} item ${i + 1} must be a list in [brackets] — this form is a list of lists.`);
        row.forEach((v: any, j: number) => checkCell(v, `${where}: ${prop} item ${i + 1}, value ${j + 1}`));
      });
    } else {
      value.forEach((v, i) => checkCell(v, `${where}: ${prop} item ${i + 1}`));
    }
    return { values: value };
  }
  if (shape === "nested") {
    throw new Error(`${where}: ${prop} "${value}" names a column, but a column is a flat list and this form needs a list of lists. With a dataset, use the long form: x, y and values for a HEATMAP, or values and group for a BOXPLOT.`);
  }
  if (!selected) {
    const why = visible.length
      ? `${visible.length} datasets are visible (${visible.map((i) => `"${i}"`).join(", ")}), so write dataset-id "…" in the chart's settings to pick one`
      : "there is no dataset — add one, or write the values inline as a list";
    throw new Error(`${where}: ${prop} "${value}" names a column, but ${why}.`);
  }
  const j = selected.columns.indexOf(value);
  if (j < 0) {
    throw new Error(
      `${where}: ${prop} "${value}" is not a column of dataset "${selected.id}". Its columns are: ${selected.columns.map((c) => `"${c}"`).join(", ")}.`,
    );
  }
  return { values: selected.rows.map((r) => r[j]), column: value };
}
