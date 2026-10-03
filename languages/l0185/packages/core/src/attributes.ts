// SPDX-License-Identifier: MIT
/**
 * L0185's vocabulary, as tables. Everything a word is — its arity, its lexicon type, what its
 * parameter must look like, its documentation — is a row here; the lexicon and the compiler's
 * handlers are generated from these rows, so they cannot disagree.
 *
 * A program is steps, then a source, then `{}`. Every word is arity 2: its parameter, then the
 * record to its right, which carries the data so far. Data flows right to left.
 */

/** What a word's parameter must be. */
export type Expects =
  | "url" // a string
  | "text" // a string
  | "path" // a dot-path string
  | "tag" // one of `oneOf`
  | "count" // a whole number ≥ 0
  | "fields" // a list of field names
  | "field" // one field name
  | "rows" // a list of records or of lists
  | "value" // any value (a let-bound source, for `from`)
  | "condition" // [field OP value?] or a lambda
  | "lambda-record" // {field: <row: …>}
  | "value-record" // {field: value}
  | "rename-record" // {old: "new"}
  | "agg-record" // {name: AGG | [AGG "field"]}
  | "sort-spec" // ["a" DESC "b" …]
  | "join-spec" // {with: … on: … kind: … prefix: …}
  | "pattern-record"; // {field: "pattern"}

export type Role = "source" | "option" | "step";

export interface StepMeta {
  role: Role;
  expects: Expects;
  oneOf?: readonly string[];
  /** For an option: the source it belongs to. */
  of?: string;
  description: string;
  example: string;
}

export const FORMATS = ["JSON", "CSV"] as const;
export const OPS = [
  "EQUALS",
  "NOT-EQUALS",
  "ABOVE",
  "AT-LEAST",
  "BELOW",
  "AT-MOST",
  "IN",
  "NOT-IN",
  "CONTAINS",
  "STARTS-WITH",
  "ENDS-WITH",
  "MISSING",
  "PRESENT",
] as const;
export const NO_VALUE_OPS = new Set(["MISSING", "PRESENT"]);
export const AGGS = ["COUNT", "SUM", "AVERAGE", "MEDIAN", "MIN", "MAX", "COUNT-DISTINCT"] as const;
export const DIRECTIONS = ["ASC", "DESC"] as const;
export const JOIN_KINDS = ["LEFT", "INNER"] as const;

/** Every tag, with its meaning. Tags are bare and uppercase. */
export const TAGS: Record<string, string> = {
  JSON: "Read the fetched body as JSON.",
  CSV: "Read the fetched body as CSV, with a header row.",
  EQUALS: "The field equals the value.",
  "NOT-EQUALS": "The field does not equal the value (missing fields count as not equal).",
  ABOVE: "The field is greater than the value.",
  "AT-LEAST": "The field is greater than or equal to the value.",
  BELOW: "The field is less than the value.",
  "AT-MOST": "The field is less than or equal to the value.",
  IN: "The field is one of a list of values.",
  "NOT-IN": "The field is none of a list of values.",
  CONTAINS: "The field's text contains the value.",
  "STARTS-WITH": "The field's text starts with the value.",
  "ENDS-WITH": "The field's text ends with the value.",
  MISSING: "The field is missing or null.",
  PRESENT: "The field is present and not null.",
  COUNT: "How many records (or, with a field, how many non-null values).",
  SUM: "The total of a field.",
  AVERAGE: "The mean of a field.",
  MEDIAN: "The median of a field.",
  MIN: "The smallest value of a field.",
  MAX: "The largest value of a field.",
  "COUNT-DISTINCT": "How many different values a field has.",
  ASC: "Smallest first.",
  DESC: "Largest first.",
  LEFT: "Keep every record on the left, matched or not.",
  INNER: "Keep only records that match on both sides.",
};

/** The words, keyed by their compiler tag name (`GROUP_BY` is the word `group-by`). */
export const stepFields: Record<string, StepMeta> = {
  // Sources: exactly one, rightmost.
  FETCH: {
    role: "source",
    expects: "url",
    description: "Source: load a public https URL (JSON or CSV).",
    example: 'fetch "https://example.org/data.json" {}',
  },
  ROWS: {
    role: "source",
    expects: "rows",
    description: "Source: inline data — a list of records, or a list of lists with `columns`.",
    example: 'rows [{name: "Pen" price: 1.5}] {}',
  },
  FROM: {
    role: "source",
    expects: "value",
    description: "Source: data produced elsewhere in the program, e.g. a source bound with `let`.",
    example: "from customers {}",
  },
  // Options: to the right of the source that uses them.
  PARSE: {
    role: "option",
    of: "fetch",
    expects: "tag",
    oneOf: FORMATS,
    description: "How to read a fetched body: JSON or CSV. Defaults to the content type, then a sniff.",
    example: 'fetch "https://example.org/data.csv" parse CSV {}',
  },
  AT: {
    role: "option",
    of: "fetch",
    expects: "path",
    description: "Where the data is inside the fetched JSON, as a dot-path.",
    example: 'fetch "https://example.org/api.json" at "data.users" {}',
  },
  COLUMNS: {
    role: "option",
    of: "rows",
    expects: "fields",
    description: "Names for rows written as lists.",
    example: 'rows [["Oslo" 709]] columns ["city" "population"] {}',
  },
  CONNECTION_ID: {
    role: "option",
    of: "fetch",
    expects: "text",
    description: "Reserved for authenticated sources; not available yet.",
    example: 'fetch "https://example.org/data.json" {}',
  },
  // Steps: to the left of the source; each works on the data to its right.
  WHERE: {
    role: "step",
    expects: "condition",
    description: 'Keep the records that match: `[field OP value]`, or a function of the record, e.g. `where ["age" ABOVE 30]`.',
    example: 'where ["age" ABOVE 30] fetch "https://example.org/people.json" {}',
  },
  PICK: {
    role: "step",
    expects: "fields",
    description: "Keep only these fields, in this order.",
    example: 'pick ["name" "email"] fetch "https://example.org/users.json" {}',
  },
  OMIT: {
    role: "step",
    expects: "fields",
    description: "Drop these fields.",
    example: 'omit ["password"] fetch "https://example.org/users.json" {}',
  },
  RENAME: {
    role: "step",
    expects: "rename-record",
    description: 'Rename fields: `{old: "new"}`.',
    example: 'rename {pop: "population"} fetch "https://example.org/cities.json" {}',
  },
  DERIVE: {
    role: "step",
    expects: "lambda-record",
    description: "Add or replace fields computed from each record: `{field: <row: …>}`.",
    example: 'derive {total: <row: mul (get "price" row) (get "qty" row)>} fetch "https://example.org/orders.json" {}',
  },
  FILL: {
    role: "step",
    expects: "value-record",
    description: "Replace missing or null values: `{field: value}`.",
    example: 'fill {region: "unknown"} fetch "https://example.org/sales.json" {}',
  },
  GROUP_BY: {
    role: "step",
    expects: "fields",
    description: "Group the records by these fields, for the summarize to its left.",
    example: 'summarize {orders: COUNT} group-by ["region"] fetch "https://example.org/sales.json" {}',
  },
  SUMMARIZE: {
    role: "step",
    expects: "agg-record",
    description: 'One record per group (or one for all): `{name: COUNT}` or `{name: [SUM "field"]}`.',
    example: 'summarize {orders: COUNT revenue: [SUM "amount"]} group-by ["region"] fetch "https://example.org/sales.json" {}',
  },
  SORT_BY: {
    role: "step",
    expects: "sort-spec",
    description: "Sort by fields, each optionally followed by ASC or DESC.",
    example: 'sort-by ["revenue" DESC] fetch "https://example.org/sales.json" {}',
  },
  LIMIT: {
    role: "step",
    expects: "count",
    description: "Keep the first n records.",
    example: 'limit 10 fetch "https://example.org/sales.json" {}',
  },
  SKIP: {
    role: "step",
    expects: "count",
    description: "Drop the first n records.",
    example: 'skip 10 fetch "https://example.org/sales.json" {}',
  },
  DISTINCT: {
    role: "step",
    expects: "fields",
    description: "Drop duplicate records, compared on these fields, or on whole records with `[]`.",
    example: 'distinct ["email"] fetch "https://example.org/users.json" {}',
  },
  UNNEST: {
    role: "step",
    expects: "field",
    description: "One record per element of a list field; record elements merge in as field.key.",
    example: 'unnest "items" fetch "https://example.org/orders.json" {}',
  },
  SPREAD: {
    role: "step",
    expects: "field",
    description: "Turn a record field into field.key fields.",
    example: 'spread "address" fetch "https://example.org/users.json" {}',
  },
  JOIN: {
    role: "step",
    expects: "join-spec",
    description: 'Join another data set: `{with: <source> on: "id" kind: LEFT prefix: "c-"}`.',
    example: 'join {with: customers on: ["customer-id" "id"]} fetch "https://example.org/orders.json" {}',
  },
  FORMAT: {
    role: "step",
    expects: "pattern-record",
    description: 'Format numbers as text with an Excel pattern: `{field: "$#,##0.00"}`.',
    example: 'format {revenue: "$#,##0.00"} fetch "https://example.org/sales.json" {}',
  },
};

/** `GROUP_BY` -> `group-by`. */
export const wordOf = (name: string): string => name.toLowerCase().replace(/_/g, "-");

/** The lexicon type of a word: `<param record: record>`. */
export function typeOf(meta: StepMeta): string {
  const param: Record<Expects, string> = {
    url: "string",
    text: "string",
    path: "string",
    tag: "tag",
    count: "number",
    fields: "list",
    field: "string",
    rows: "list",
    value: "any",
    condition: "list|lambda",
    "lambda-record": "record",
    "value-record": "record",
    "rename-record": "record",
    "agg-record": "record",
    "sort-spec": "list",
    "join-spec": "record",
    "pattern-record": "record",
  };
  return `<${param[meta.expects]} record: record>`;
}

/* ---------------------------------------------------------------- values */

/**
 * L0000 records arrive as `{_type: "record", _entries: Map}` with keys prefixed `tag:`/`str:`/
 * `num:`. Steps work on plain objects.
 */
export function toPlainObject(val: any): any {
  if (val !== null && typeof val === "object" && val._type === "record" && val._entries instanceof Map) {
    const obj: any = {};
    for (const [k, v] of val._entries) obj[(k as string).replace(/^(tag|str|num):/, "")] = toPlainObject(v);
    return obj;
  }
  if (Array.isArray(val)) return val.map(toPlainObject);
  return val;
}

export const isTag = (v: any): boolean => v !== null && typeof v === "object" && !Array.isArray(v) && typeof v.tag === "string";

export const isRecord = (v: any): boolean => v !== null && typeof v === "object" && !Array.isArray(v) && !isTag(v);

export function showValue(v: any): string {
  if (v === undefined) return "nothing";
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (isTag(v)) return `the tag ${v.tag}`;
  if (Array.isArray(v)) return "a list";
  if (typeof v === "object") return "a record";
  return String(v);
}
