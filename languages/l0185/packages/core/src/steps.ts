// SPDX-License-Identifier: MIT
/**
 * What each word does to the record to its right. The record — the State — carries the data so
 * far plus working annotations (source options, grouping); it is never the output: PROG unwraps
 * it to `data`. Every function here is pure apart from `fetch`, and throws an Error whose
 * message is the compile error.
 */
import { Decimal } from "decimal.js";
import { formatNumber } from "@graffiticode/l0000";
import { AGGS, DIRECTIONS, JOIN_KINDS, NO_VALUE_OPS, OPS, isRecord, isTag, showValue, stepFields, toPlainObject, wordOf } from "./attributes.js";
import { assertField, getPath } from "./paths.js";
import { parseBody } from "./source.js";

export const MAX_ROWS = 50_000;

export interface State {
  __l0185: true;
  data?: any;
  source?: string;
  opts: Record<string, any>;
  groupBy?: string[];
}

export const isState = (v: any): v is State => !!v && typeof v === "object" && v.__l0185 === true;

/** What a step can ask of the compiler: apply a lambda node to a record, and fetch. */
export interface Ctx {
  call(nodeId: number, row: any): any;
  fetch(url: string): Promise<any>;
}

const q = JSON.stringify;

/** A lambda kept as its node, for `where (<row: …>)` and `derive {f: <row: …>}`. */
export interface LambdaRef {
  lambda: number;
}
export const isLambdaRef = (v: any): v is LambdaRef => !!v && typeof v === "object" && typeof v.lambda === "number" && Object.keys(v).length === 1;

/* ------------------------------------------------------------------ helpers */

function rowsOf(word: string, state: State): any[] {
  if (!Array.isArray(state.data)) {
    throw new Error(`${word}: needs a list of records, but the data to its right is ${showValue(state.data)}. Use at "…" on the fetch to reach the list.`);
  }
  return state.data;
}

function withData(state: State, data: any): State {
  if (Array.isArray(data) && data.length > MAX_ROWS) {
    throw new Error(`The data has ${data.length} records, more than the ${MAX_ROWS} L0185 processes. Fetch a smaller file or a narrower query.`);
  }
  return { ...state, data };
}

function fieldList(word: string, v: any, allowEmpty = false): string[] {
  if (!Array.isArray(v) || v.some((f) => typeof f !== "string") || (!allowEmpty && v.length === 0)) {
    throw new Error(`${word}: expects a list of field names in "quotes", e.g. ${word} ["name" "email"]. Got ${showValue(v)}.`);
  }
  return v;
}

function tagOf(v: any): string | undefined {
  return isTag(v) ? v.tag : undefined;
}

const isNum = (v: any) => typeof v === "number" && Number.isFinite(v);
const numeric = (v: any) => (isNum(v) ? v : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : undefined);

/** Ordering for sort and MIN/MAX: numbers numerically, then text; null/undefined last. */
function compare(a: any, b: any): number {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an || bn) return an && bn ? 0 : an ? 1 : -1;
  const na = numeric(a);
  const nb = numeric(b);
  if (na !== undefined && nb !== undefined) return na - nb;
  if (na !== undefined) return -1;
  if (nb !== undefined) return 1;
  return String(a).localeCompare(String(b));
}

/* ------------------------------------------------------------------ sources */

function startSource(word: string, state: State): Record<string, any> {
  if (state.data !== undefined) {
    throw new Error(`${word}: the data already has a source to its right (${state.source}). A program has exactly one source, rightmost, just before {}.`);
  }
  const opts = state.opts;
  for (const [optName, value] of Object.entries(opts)) {
    if (value === undefined) continue;
    const owner = stepFields[optName].of;
    if (owner !== word) {
      throw new Error(`${wordOf(optName)}: is an option of ${owner}, not ${word}. Write it to the right of ${owner}, e.g. ${stepFields[optName].example}.`);
    }
  }
  return opts;
}

export async function fetchSource(url: any, state: State, ctx: Ctx): Promise<State> {
  const opts = startSource("fetch", state);
  if (typeof url !== "string") throw new Error(`fetch: expects a URL in "quotes", e.g. fetch "https://example.org/data.json" {}. Got ${showValue(url)}.`);
  if (opts.CONNECTION_ID !== undefined) {
    throw new Error("connection-id: authenticated sources are not available yet. Use a public https URL.");
  }
  const body = await ctx.fetch(url);
  let data = parseBody(url, body, opts.PARSE);
  if (opts.AT !== undefined) {
    const at = getPath(data, opts.AT);
    if (at === undefined) {
      const keys = data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data) : [];
      throw new Error(`at: ${q(opts.AT)} names nothing in the data from ${q(url)}.${keys.length ? ` Its top-level keys are: ${keys.slice(0, 20).map((k) => q(k)).join(", ")}.` : ""}`);
    }
    data = at;
  }
  return withData({ __l0185: true, opts: {}, source: "fetch", groupBy: state.groupBy }, data);
}

export function rowsSource(rows: any, state: State): State {
  const opts = startSource("rows", state);
  if (!Array.isArray(rows)) throw new Error(`rows: expects a list of records or of lists, e.g. rows [{name: "Pen" price: 1.5}] {}. Got ${showValue(rows)}.`);
  let data = rows;
  if (rows.some(Array.isArray)) {
    const columns = opts.COLUMNS;
    if (!columns) throw new Error(`rows: rows written as lists need columns to name them, to the right of rows: rows [["Oslo" 709]] columns ["city" "population"] {}.`);
    data = rows.map((r: any, i: number) => {
      if (!Array.isArray(r) || r.length !== columns.length) {
        const n = Array.isArray(r) ? r.length : 1;
        throw new Error(`rows: row ${i + 1} has ${n} ${n === 1 ? "value" : "values"}, but there are ${columns.length} columns (${columns.join(", ")}).`);
      }
      return Object.fromEntries(columns.map((c: string, j: number) => [c, r[j]]));
    });
  } else if (opts.COLUMNS) {
    throw new Error("columns: names rows written as lists; these rows are records, which carry their own field names. Remove columns.");
  }
  return withData({ __l0185: true, opts: {}, source: "rows", groupBy: state.groupBy }, data);
}

export function fromSource(value: any, state: State): State {
  startSource("from", state);
  const data = isState(value) ? value.data : toPlainObject(value);
  if (data === undefined) throw new Error("from: expects data, e.g. a source bound with let: let people = fetch \"https://…\" {}.. … from people {}.");
  return withData({ __l0185: true, opts: {}, source: "from", groupBy: state.groupBy }, data);
}

export function option(name: string, value: any, state: State): State {
  const word = wordOf(name);
  const meta = stepFields[name];
  if (state.data !== undefined) {
    throw new Error(`${word}: is an option of ${meta.of}, so it goes to the right of ${meta.of}, not to its left: ${meta.example}.`);
  }
  if (state.opts[name] !== undefined) throw new Error(`${word}: is given twice.`);
  let v = value;
  if (meta.expects === "tag") {
    v = tagOf(value);
    if (!v || !meta.oneOf!.includes(v)) throw new Error(`${word}: expects ${meta.oneOf!.join(" or ")}, written bare, e.g. ${meta.example}. Got ${showValue(value)}.`);
  } else if (meta.expects === "fields") {
    v = fieldList(word, value);
  } else if (typeof value !== "string") {
    throw new Error(`${word}: expects text in "quotes", e.g. ${meta.example}. Got ${showValue(value)}.`);
  }
  return { ...state, opts: { ...state.opts, [name]: v } };
}

/* ------------------------------------------------------------------ steps */

function needData(word: string, state: State): void {
  if (state.data === undefined) {
    throw new Error(`${word}: there is no data to its right. The source goes last, just before {}: ${stepFields[word.toUpperCase().replace(/-/g, "_")]?.example ?? `${word} … fetch "https://…" {}`}.`);
  }
}

export function where(cond: any, state: State, ctx: Ctx): State {
  needData("where", state);
  const rows = rowsOf("where", state);
  if (isLambdaRef(cond)) {
    return withData(
      state,
      rows.filter((row, i) => {
        const keep = ctx.call(cond.lambda, row);
        if (typeof keep !== "boolean") {
          throw new Error(`where: the function returned ${showValue(keep)} for record ${i + 1}; it must return true or false, e.g. where (<row: gt (get "age" row) 30>).`);
        }
        return keep;
      }),
    );
  }
  if (!Array.isArray(cond) || typeof cond[0] !== "string" || !tagOf(cond[1])) {
    throw new Error(`where: expects [field OP value], e.g. where ["age" ABOVE 30], or a function of the record, e.g. where (<row: gt (get "age" row) 30>). Got ${showValue(cond)}.`);
  }
  const [field, opTag, value] = cond;
  const op = tagOf(opTag)!;
  if (!(OPS as readonly string[]).includes(op)) throw new Error(`where: ${op} is not an operator. Use one of ${OPS.join(", ")}.`);
  if (NO_VALUE_OPS.has(op) ? cond.length !== 2 : cond.length !== 3) {
    throw new Error(NO_VALUE_OPS.has(op) ? `where: ${op} takes no value: where [${q(field)} ${op}].` : `where: ${op} needs a value: where [${q(field)} ${op} …].`);
  }
  if ((op === "IN" || op === "NOT-IN") && !Array.isArray(value)) throw new Error(`where: ${op} needs a list of values, e.g. where [${q(field)} ${op} ["a" "b"]].`);
  assertField("where", field, rows);
  const eq = (a: any, b: any) => {
    const na = numeric(a);
    const nb = numeric(b);
    return na !== undefined && nb !== undefined && (isNum(a) || isNum(b)) ? na === nb : a === b;
  };
  const ordered = (a: any, b: any, test: (d: number) => boolean) => {
    if (a === null || a === undefined) return false;
    const na = numeric(a);
    const nb = numeric(b);
    if (na !== undefined && nb !== undefined) return test(na - nb);
    if (typeof a === "string" && typeof b === "string") return test(a.localeCompare(b));
    throw new Error(`where: cannot compare ${showValue(a)} in ${q(field)} with ${showValue(b)} using ${op}.`);
  };
  const text = (a: any, f: (s: string) => boolean) => a !== null && a !== undefined && f(String(a));
  const test = (a: any): boolean => {
    switch (op) {
      case "EQUALS": return a !== null && a !== undefined && eq(a, value);
      case "NOT-EQUALS": return a === null || a === undefined || !eq(a, value);
      case "ABOVE": return ordered(a, value, (d) => d > 0);
      case "AT-LEAST": return ordered(a, value, (d) => d >= 0);
      case "BELOW": return ordered(a, value, (d) => d < 0);
      case "AT-MOST": return ordered(a, value, (d) => d <= 0);
      case "IN": return a !== null && a !== undefined && value.some((v: any) => eq(a, v));
      case "NOT-IN": return a === null || a === undefined || !value.some((v: any) => eq(a, v));
      case "CONTAINS": return text(a, (s) => s.includes(String(value)));
      case "STARTS-WITH": return text(a, (s) => s.startsWith(String(value)));
      case "ENDS-WITH": return text(a, (s) => s.endsWith(String(value)));
      case "MISSING": return a === null || a === undefined;
      default: return a !== null && a !== undefined; // PRESENT
    }
  };
  return withData(state, rows.filter((row) => test(getPath(row, field))));
}

export function pick(fields: any, state: State): State {
  needData("pick", state);
  const rows = rowsOf("pick", state);
  const fs = fieldList("pick", fields);
  fs.forEach((f) => assertField("pick", f, rows));
  return withData(state, rows.map((r) => Object.fromEntries(fs.map((f) => [f, getPath(r, f) ?? null]))));
}

export function omit(fields: any, state: State): State {
  needData("omit", state);
  const rows = rowsOf("omit", state);
  const fs = new Set(fieldList("omit", fields));
  [...fs].forEach((f) => assertField("omit", f, rows));
  return withData(state, rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !fs.has(k)))));
}

export function rename(map: any, state: State): State {
  needData("rename", state);
  const rows = rowsOf("rename", state);
  if (!isRecord(map) || Object.values(map).some((v) => typeof v !== "string")) {
    throw new Error(`rename: expects {old: "new"}, e.g. rename {pop: "population"}. Got ${showValue(map)}.`);
  }
  Object.keys(map).forEach((f) => assertField("rename", f, rows));
  return withData(
    state,
    rows.map((r) => {
      const out: any = {};
      for (const [k, v] of Object.entries(r)) {
        const nk = map[k] ?? k;
        if (Object.prototype.hasOwnProperty.call(out, nk)) {
          throw new Error(`rename: ${q(k)} would become ${q(nk)}, which is already a field. Rename or omit ${q(nk)} first.`);
        }
        out[nk] = v;
      }
      return out;
    }),
  );
}

export function derive(entries: [string, any][], state: State, ctx: Ctx): State {
  needData("derive", state);
  const rows = rowsOf("derive", state);
  if (!entries.length) throw new Error("derive: expects {field: <row: …>}, e.g. derive {total: <row: mul (get \"price\" row) (get \"qty\" row)>}.");
  return withData(
    state,
    rows.map((row, i) => {
      const out = { ...row };
      for (const [field, v] of entries) {
        let val = isLambdaRef(v) ? ctx.call(v.lambda, out) : v;
        val = toPlainObject(val);
        if (val === undefined) {
          throw new Error(`derive: the function for ${q(field)} returned nothing for record ${i + 1}. Check its field names, e.g. derive {${field}: <row: get "price" row>}.`);
        }
        out[field] = val;
      }
      return out;
    }),
  );
}

export function fill(map: any, state: State): State {
  needData("fill", state);
  const rows = rowsOf("fill", state);
  if (!isRecord(map) || !Object.keys(map).length) throw new Error(`fill: expects {field: value}, e.g. fill {region: "unknown"}. Got ${showValue(map)}.`);
  return withData(
    state,
    rows.map((r) => {
      const out = { ...r };
      for (const [k, v] of Object.entries(map)) if (out[k] === null || out[k] === undefined) out[k] = v;
      return out;
    }),
  );
}

export function groupBy(fields: any, state: State): State {
  needData("group-by", state);
  const rows = rowsOf("group-by", state);
  const fs = fieldList("group-by", fields);
  fs.forEach((f) => assertField("group-by", f, rows));
  if (state.groupBy) throw new Error("group-by: is given twice before a summarize. List every field in one group-by.");
  return { ...state, groupBy: fs };
}

export function summarize(spec: any, state: State): State {
  needData("summarize", state);
  const rows = rowsOf("summarize", state);
  if (!isRecord(spec) || !Object.keys(spec).length) {
    throw new Error(`summarize: expects {name: AGG} or {name: [AGG "field"]}, e.g. summarize {orders: COUNT revenue: [SUM "amount"]}. Got ${showValue(spec)}.`);
  }
  const aggs = Object.entries(spec).map(([name, v]) => {
    const agg = tagOf(v) ?? (Array.isArray(v) ? tagOf(v[0]) : undefined);
    const field = Array.isArray(v) ? v[1] : undefined;
    if (!agg || !(AGGS as readonly string[]).includes(agg)) {
      throw new Error(`summarize: ${q(name)} must be one of ${AGGS.join(", ")}, alone or as [AGG "field"], e.g. ${name}: [SUM "amount"].`);
    }
    if (agg !== "COUNT" && typeof field !== "string") throw new Error(`summarize: ${agg} needs a field: ${name}: [${agg} "field"].`);
    if (field !== undefined) assertField("summarize", field, rows);
    return { name, agg, field };
  });
  const by = state.groupBy ?? [];
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const key = JSON.stringify(by.map((f) => getPath(r, f) ?? null));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  if (!by.length && !groups.size) groups.set("[]", []);
  const out = [...groups.entries()].map(([key, members]) => {
    const rec: any = {};
    JSON.parse(key).forEach((v: any, i: number) => (rec[by[i]] = v));
    for (const { name, agg, field } of aggs) rec[name] = aggregate(agg, field, members);
    return rec;
  });
  return { ...withData(state, out), groupBy: undefined };
}

function aggregate(agg: string, field: string | undefined, rows: any[]): any {
  const vals = field === undefined ? rows : rows.map((r) => getPath(r, field)).filter((v) => v !== null && v !== undefined);
  if (agg === "COUNT") return vals.length;
  if (agg === "COUNT-DISTINCT") return new Set(vals.map((v) => JSON.stringify(v))).size;
  if (agg === "MIN" || agg === "MAX") {
    if (!vals.length) return null;
    return vals.reduce((a, b) => (compare(a, b) * (agg === "MIN" ? 1 : -1) <= 0 ? a : b));
  }
  const nums = vals.map((v) => {
    const n = numeric(v);
    if (n === undefined) throw new Error(`summarize: ${agg} of ${q(field)} needs numbers; it found ${showValue(v)}.`);
    return n;
  });
  if (!nums.length) return null;
  if (agg === "MEDIAN") {
    const s = [...nums].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : new Decimal(s[m - 1]).plus(s[m]).div(2).toNumber();
  }
  const sum = nums.reduce((acc, n) => acc.plus(n), new Decimal(0));
  return agg === "SUM" ? sum.toNumber() : sum.div(nums.length).toNumber();
}

export function sortBy(spec: any, state: State): State {
  needData("sort-by", state);
  const rows = rowsOf("sort-by", state);
  if (!Array.isArray(spec) || !spec.length || typeof spec[0] !== "string") {
    throw new Error(`sort-by: expects fields, each optionally followed by ASC or DESC, e.g. sort-by ["revenue" DESC "name"]. Got ${showValue(spec)}.`);
  }
  const keys: { field: string; dir: number }[] = [];
  for (const item of spec) {
    if (typeof item === "string") keys.push({ field: item, dir: 1 });
    else if ((DIRECTIONS as readonly string[]).includes(tagOf(item) ?? "") && keys.length) keys[keys.length - 1].dir = tagOf(item) === "DESC" ? -1 : 1;
    else throw new Error(`sort-by: ${showValue(item)} is not a field or ASC/DESC. Write sort-by ["revenue" DESC "name"].`);
  }
  keys.forEach((k) => assertField("sort-by", k.field, rows));
  return withData(
    state,
    [...rows].sort((a, b) => {
      for (const { field, dir } of keys) {
        const va = getPath(a, field);
        const vb = getPath(b, field);
        const missA = va === null || va === undefined;
        const missB = vb === null || vb === undefined;
        if (missA || missB) {
          if (missA && missB) continue;
          return missA ? 1 : -1; // nulls last, whichever direction
        }
        const c = compare(va, vb) * dir;
        if (c) return c;
      }
      return 0;
    }),
  );
}

function count(word: string, n: any): number {
  if (!Number.isInteger(n) || n < 0) throw new Error(`${word}: expects a whole number of records, e.g. ${word} 10. Got ${showValue(n)}.`);
  return n;
}

export function limit(n: any, state: State): State {
  needData("limit", state);
  return withData(state, rowsOf("limit", state).slice(0, count("limit", n)));
}

export function skip(n: any, state: State): State {
  needData("skip", state);
  return withData(state, rowsOf("skip", state).slice(count("skip", n)));
}

export function distinct(fields: any, state: State): State {
  needData("distinct", state);
  const rows = rowsOf("distinct", state);
  const fs = fieldList("distinct", fields, true);
  fs.forEach((f) => assertField("distinct", f, rows));
  const seen = new Set<string>();
  return withData(
    state,
    rows.filter((r) => {
      const key = JSON.stringify(fs.length ? fs.map((f) => getPath(r, f) ?? null) : r);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}

export function unnest(field: any, state: State): State {
  needData("unnest", state);
  const rows = rowsOf("unnest", state);
  if (typeof field !== "string") throw new Error(`unnest: expects one field name, e.g. unnest "items". Got ${showValue(field)}.`);
  assertField("unnest", field, rows);
  const out: any[] = [];
  for (const r of rows) {
    const v = r[field];
    if (!Array.isArray(v)) {
      out.push(r);
      continue;
    }
    const { [field]: _drop, ...rest } = r;
    for (const el of v) {
      if (isRecord(el)) out.push({ ...rest, ...Object.fromEntries(Object.entries(el).map(([k, x]) => [`${field}.${k}`, x])) });
      else out.push({ ...rest, [field]: el });
    }
  }
  return withData(state, out);
}

export function spread(field: any, state: State): State {
  needData("spread", state);
  const rows = rowsOf("spread", state);
  if (typeof field !== "string") throw new Error(`spread: expects one field name, e.g. spread "address". Got ${showValue(field)}.`);
  assertField("spread", field, rows);
  return withData(
    state,
    rows.map((r) => {
      if (!isRecord(r[field])) return r;
      const out: any = {};
      for (const [k, v] of Object.entries(r)) {
        if (k === field) for (const [ik, iv] of Object.entries(v as any)) out[`${field}.${ik}`] = iv;
        else out[k] = v;
      }
      return out;
    }),
  );
}

export function join(spec: any, state: State): State {
  needData("join", state);
  const left = rowsOf("join", state);
  if (!isRecord(spec) || spec.with === undefined) {
    throw new Error('join: expects {with: <data> on: "field"}, e.g. join {with: customers on: ["customer-id" "id"]}, with customers bound by let.');
  }
  const unknown = Object.keys(spec).filter((k) => !["with", "on", "kind", "prefix"].includes(k));
  if (unknown.length) throw new Error(`join: ${unknown.map((k) => q(k)).join(", ")} is not part of join. It takes: with, on, kind, prefix.`);
  const right = isState(spec.with) ? spec.with.data : spec.with;
  if (!Array.isArray(right)) throw new Error("join: with must be a list of records, e.g. a source bound with let: let customers = fetch \"https://…\" {}..");
  const on = spec.on;
  const [lk, rk] = typeof on === "string" ? [on, on] : Array.isArray(on) && on.length === 2 ? on : [];
  if (typeof lk !== "string" || typeof rk !== "string") throw new Error('join: on is a field name, or [left right] when they differ, e.g. on: ["customer-id" "id"].');
  const kind = spec.kind === undefined ? "LEFT" : tagOf(spec.kind);
  if (!kind || !(JOIN_KINDS as readonly string[]).includes(kind)) throw new Error("join: kind is LEFT or INNER, written bare.");
  const prefix = spec.prefix ?? "";
  if (typeof prefix !== "string") throw new Error('join: prefix is text, e.g. prefix: "customer-".');
  assertField("join", lk, left);
  assertField("join", rk, right);
  const index = new Map<string, any[]>();
  for (const r of right) {
    const key = JSON.stringify(getPath(r, rk) ?? null);
    if (!index.has(key)) index.set(key, []);
    index.get(key)!.push(r);
  }
  const out: any[] = [];
  for (const l of left) {
    const matches = index.get(JSON.stringify(getPath(l, lk) ?? null)) ?? [];
    if (!matches.length && kind === "LEFT") out.push(l);
    for (const m of matches) {
      const rec = { ...l };
      for (const [k, v] of Object.entries(m)) {
        if (k === rk) continue;
        const nk = prefix + k;
        if (Object.prototype.hasOwnProperty.call(rec, nk)) {
          throw new Error(`join: both sides have a field ${q(nk)}. Add a prefix, e.g. prefix: "right-".`);
        }
        rec[nk] = v;
      }
      out.push(rec);
    }
  }
  return withData(state, out);
}

export function format(map: any, state: State): State {
  needData("format", state);
  const rows = rowsOf("format", state);
  if (!isRecord(map) || Object.values(map).some((v) => typeof v !== "string")) {
    throw new Error(`format: expects {field: "pattern"}, e.g. format {revenue: "$#,##0.00"}. Got ${showValue(map)}.`);
  }
  Object.keys(map).forEach((f) => assertField("format", f, rows));
  return withData(
    state,
    rows.map((r) => {
      const out = { ...r };
      for (const [f, pattern] of Object.entries(map)) {
        if (isNum(out[f])) out[f] = formatNumber(pattern as string, out[f]);
      }
      return out;
    }),
  );
}
