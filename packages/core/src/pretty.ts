// SPDX-License-Identifier: MIT
/**
 * DATA -> L0014 source.
 *
 * This is what makes an existing rule set recoverable. Every rule set TransLaTeX
 * ships was compiled from an L120 program on a host that no longer exists, and
 * the compiled JSON is all that survives — so the source is reconstructed from
 * the output rather than found. The reconstruction is checkable, which is the
 * point: compile what this emits and the result must equal the input exactly
 * (see rules.test.ts).
 *
 * BACKSLASHES ARE DOUBLED, and this is the one place the port CANNOT copy L120.
 * L120's parser did not process escapes, so its source says `"\times"`. The
 * modern parser does, and it eats them silently:
 *
 *     "\times"  ->  <TAB>imes
 *     "\nless"  ->  <NEWLINE>less
 *     "\right"  ->  <CR>ight
 *     "\\times" ->  \times          correct
 *
 * No error, just a mangled pattern that then fails to match. So every string is
 * emitted through JSON.stringify. A corollary worth knowing if the original
 * source is ever recovered from a backup: it cannot be fed to L0014 verbatim,
 * it has to be backslash-doubled first.
 *
 * Comments are `/* ... *\/`, not L120's `|`. The modern parser has NO line
 * comment: `|`, `--` and `#` are rejected outright, and `//` is not a comment
 * either — it lexes as two division operators, which parses without complaint
 * until the text happens to contain a `.` and then fails somewhere else
 * entirely. So a recovered L120 source needs its comment markers rewritten as
 * well as its backslashes doubled.
 *
 * What this does NOT recover is commentary — L120 sources carried `|Sets`,
 * `|Trig` section headers that the compiled form does not retain. Those come
 * back by hand, from the recovered ancestor source if there is one.
 */

/** A string as an L0014 literal. JSON's escaping is exactly what the parser expects. */
const str = (s: any) => JSON.stringify(String(s));

const isPlainObject = (v: any) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Render any compiled value back to source. */
function value(v: any, indent: string): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    const parts = v.map((x) => value(x, indent + "  "));
    // Keep short lists — a [source, expected] test pair, a type's alternatives —
    // on one line; they are read as units.
    const oneLine = `[${parts.join(", ")}]`;
    if (oneLine.length <= 96 && !oneLine.includes("\n")) return oneLine;
    return `[\n${parts.map((p) => indent + "  " + p).join(",\n")}\n${indent}]`;
  }
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    if (keys.length === 0) return "{}";
    const parts = keys.map((k) => `${str(k)}: ${value(v[k], indent + "  ")}`);
    const oneLine = `{ ${parts.join(", ")} }`;
    if (oneLine.length <= 96 && !oneLine.includes("\n")) return oneLine;
    return `{\n${parts.map((p) => indent + "  " + p).join(",\n")}\n${indent}}`;
  }
  if (typeof v === "string") return str(v);
  return JSON.stringify(v);
}

/**
 * Invert the array-wrap the RULES handler applies.
 *
 * `rules { "?+?": "%1+%2" }` compiles to `{"?+?": ["%1+%2"]}`, so a
 * one-element list round-trips back to the bare value. Anything longer stays a
 * list. Measured across every live rule set, expansions are only ever
 * `["string"]` or `[{...}]`, so the single-element case is the whole corpus —
 * but the general case is handled rather than assumed.
 */
function unwrapRule(v: any): any {
  return Array.isArray(v) && v.length === 1 ? v[0] : v;
}

function block(word: string, body: string): string {
  return `${word} ${body}`;
}

function record(entries: [string, any][]): string {
  if (entries.length === 0) return "{}";
  const parts = entries.map(([k, v]) => `  ${str(k)}: ${value(v, "  ")}`);
  return `{\n${parts.join(",\n")}\n}`;
}

export interface ToSourceOptions {
  /** Emitted as a leading block comment. */
  header?: string;
}

/**
 * Emit L0014 source for a compiled `{options, tests}` payload (or a bare
 * `options`). Statement order is fixed — words, types, rules, options, tests —
 * because it reads best, not because it matters: PROG merges rather than
 * requiring an order, unlike L120 which needed `tests` last.
 */
export function toSource(data: any, opts: ToSourceOptions = {}): string {
  const options = data && data.options ? data.options : data || {};
  const tests = (data && data.tests) || [];
  const out: string[] = [];

  if (opts.header) {
    // A single block comment: the parser has no line-comment form, and `*/`
    // is the only terminator, so the header must not contain one.
    out.push(`/*\n${String(opts.header).replace(/\*\//g, "* /")}\n*/`);
    out.push("");
  }

  if (options.words && Object.keys(options.words).length) {
    out.push(block("words", record(Object.entries(options.words))));
    out.push("");
  }
  if (options.types && Object.keys(options.types).length) {
    out.push(block("types", record(Object.entries(options.types))));
    out.push("");
  }
  if (options.rules && Object.keys(options.rules).length) {
    const entries = Object.entries(options.rules).map(
      ([k, v]) => [k, unwrapRule(v)] as [string, any],
    );
    out.push(block("rules", record(entries)));
    out.push("");
  }

  // Parser options, in the order collectOptions emits them.
  const optionWords: [string, string][] = [
    ["allowThousandsSeparator", "allow-thousands-separator"],
    ["setDecimalSeparator", "set-decimal-separator"],
    ["setThousandsSeparator", "set-thousands-separator"],
    ["allowInterval", "allow-interval"],
    ["ignoreText", "ignore-text"],
    ["ignoreCoefficientOne", "ignore-coefficient-one"],
  ];
  let wroteOption = false;
  for (const [field, word] of optionWords) {
    if (options[field] !== undefined) {
      out.push(block(word, value(options[field], "")));
      wroteOption = true;
    }
  }
  if (wroteOption) out.push("");

  // The corpus round-trips as [source, expected] pairs — the shape it is
  // authored in — not as the scored {score, actual, ...} records compilation
  // produces.
  const pairs = tests.map((t: any) =>
    Array.isArray(t) ? t : [t.source, t.expected ?? ""],
  );
  out.push(block("tests", value(pairs, "")));

  return out.join("\n").replace(/\n+$/, "") + "\n..\n";
}
