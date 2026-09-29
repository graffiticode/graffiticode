// SPDX-License-Identifier: MIT
/**
 * L0179's spreadsheet vocabulary.
 *
 * This file used to REPLACE translatex's `$fn` expander wholesale, because that
 * was the only way to add a function: `reducerBuilders` was module-private, and
 * the name also had to be hand-added to `words` and to `types.fn` in three
 * separate rule sets. Four edits that had to agree, which is how L0166 and
 * L0179 ended up shipping rule sets whose entire difference was the word
 * `power`.
 *
 * translatex 0.25.0 derives all of that from one descriptor. What is left here
 * is POWER itself and `prepareFormula`, which works around a defect in
 * parselatex rather than in translatex and therefore still has to live in a
 * consumer.
 *
 * No DOM, no React, no ProseMirror — this is imported by ../scoring/score.ts,
 * which Learnosity runs server-side.
 */
import { createSpreadsheet } from "@graffiticode/translatex/src/spreadsheet.js";

import { toUpperCase, stripAbsoluteReferences } from "./normalize.js";

/**
 * POWER(base, exponent), Excel's spelling of `base ^ exponent`.
 *
 * Decimal rather than `Math.pow`, for the reason every reducer upstream uses
 * it: an integer exponent has to come out EXACT. `POWER(1.05,4)` is
 * 1.21550625, not 1.2155062500000004 — and the difference is not cosmetic,
 * because a scored cell compares the learner's typed value against this string.
 *
 * `#NUM!` covers both of Excel's rejections here — an argument that is not a
 * number, and a result that is not real — because the engine's error surface is
 * a marker string, not a code.
 */
const POWER = {
  name: "POWER",
  minArgs: 2,
  maxArgs: 2,
  apply: ({ args, helpers }: any) => {
    const [base, exponent] = args.map((a: string) => helpers.getCellValue(a));
    try {
      const result = helpers.toDecimal("POWER", 0, base)
        .pow(helpers.toDecimal("POWER", 1, exponent));
      return result.isFinite() ? `${result}` : "#NUM!";
    } catch {
      return "#NUM!";
    }
  },
};

/**
 * MAX and MIN over any mix of values and ranges.
 *
 * Arguments that aren't numbers are skipped, as Excel skips text and blanks in a range and as SUM
 * already does here. With no numbers at all the result is 0, which is Excel's answer too.
 */
const extremum = (name: string, pick: "max" | "min") => ({
  name,
  minArgs: 1,
  maxArgs: Infinity,
  apply: ({ args, helpers }: any) => {
    const numbers = args
      .map((a: string) => helpers.getCellValue(a))
      .filter((v: any) => helpers.isValidDecimal(v))
      .map((v: any) => new helpers.Decimal(v));
    return numbers.length ? `${helpers.Decimal[pick](...numbers)}` : "0";
  },
});

const MAX = extremum("MAX", "max");
const MIN = extremum("MIN", "min");

/** ABS(number). An argument that is not a number is #VALUE!, as in Excel. */
const ABS = {
  name: "ABS",
  minArgs: 1,
  maxArgs: 1,
  apply: ({ args, helpers }: any) => {
    const value = helpers.getCellValue(args[0]);
    return helpers.isValidDecimal(value) ? `${new helpers.Decimal(value).abs()}` : "#VALUE!";
  },
};

const sheet = createSpreadsheet({ functions: [POWER, MAX, MIN, ABS] });

/** translatex's expanders plus L0179's functions. */
export const expanders = sheet.expanders;

/** The generated evaluation rule set. `words` and `types.fn` come from the registry. */
export const evalRules = sheet.rules.evalRules;

/** Detect a call that did not resolve. See prepareFormula for why one still can. */
export const checkResult = (value: any) => sheet.checkResult(value);

/**
 * A formula's string literals, rebound as cells the parser can read.
 *
 * parselatex rejects `"` outright (1004), so `=IF(A1>B1,A1,"")`, the ordinary way to leave a cell
 * blank, was #NAME!. Each literal becomes a synthetic reference (`Z900000000`, ...) bound in `env`
 * to the literal's text, which IF passes through and `=`/`<>` compare as text.
 *
 * The empty string is bound to a sentinel instead, and `decode` swaps it back: translatex resolves
 * a reference as `env[name].val || name`, so a reference whose value is "" evaluates to its own
 * NAME.
 *
 * A non-numeric literal used as an arithmetic operand (`=A1+"x"`) sets `error`. The reducers skip
 * a value that isn't a number, so it would otherwise evaluate silently to 10. Excel says #VALUE!.
 *
 * The row numbers are far past anything the compiler would author, so a synthetic name can't
 * collide with a real cell. Excel's doubled quote (`"say ""hi"""`) is unescaped.
 */
const LITERAL_ROW = 900000000;
const EMPTY = `${String.fromCharCode(3)}EMPTY${String.fromCharCode(3)}`;
const ARITHMETIC = /[-+*/^%&]/;

export const bindStringLiterals = (text: any) => {
  const env: any = {};
  let error: string | undefined;
  let index = 0;
  if (typeof text !== "string" || text.indexOf("\"") < 0) {
    return { text, env, error, decode: (val: any) => val };
  }
  const bound = text.replace(/"((?:[^"]|"")*)"/g, (match: string, body: string, at: number) => {
    const literal = body.replace(/""/g, "\"");
    const before = text.slice(0, at).trimEnd().slice(-1);
    const after = text.slice(at + match.length).trimStart().charAt(0);
    const isOperand = ARITHMETIC.test(before) || ARITHMETIC.test(after);
    if (isOperand && (literal.trim() === "" || isNaN(Number(literal)))) {
      error ??= `Text used as a number: ${match}`;
    }
    const name = `Z${LITERAL_ROW + index++}`;
    env[name] = { val: literal === "" ? EMPTY : literal, type: "text" };
    return name;
  });
  const decode = (val: any) => (
    typeof val === "string" && val.indexOf(EMPTY) >= 0 ? val.split(EMPTY).join("") : val
  );
  return { text: bound, env, error, decode };
};

/** The function names the rule set knows, upper-cased as a formula is when scanned. */
const FN_NAMES = new Set<string>(evalRules.types.fn.map((n: string) => n.toUpperCase()));

const isQuoteChar = (c: string) => c === "\"" || c === "'" || c === "`";

/** The index of the `)` closing the `(` at `open`, or -1. Parens inside a string literal don't count. */
const matchParen = (text: string, open: number): number => {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (isQuoteChar(c)) { inString = !inString; continue; }
    if (inString) continue;
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
};

/**
 * Excel's not-equal, `<>`, spelled `!=` outside quoted text.
 *
 * The rule set has `?!=?` and nothing for `<>`, and parselatex has no `<>` token, so `A1<>A2` lexed
 * as `<` then `>` and every `IF(x<>y, …)` took its true branch, equal or not.
 */
const spellNotEqual = (text: string): string => {
  if (text.indexOf("<>") < 0) return text;
  let out = "";
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (isQuoteChar(c)) {
      quote = c;
    } else if (c === "<" && text[i + 1] === ">") {
      out += "!=";
      i++;
      continue;
    }
    out += c;
  }
  return out;
};

/**
 * Excel's exponent, `a^b`, spelled `POWER(a,b)` outside quoted text.
 *
 * parselatex reads `^` as a LaTeX superscript, which is wrong for a spreadsheet in four ways:
 * `2^10` takes one digit of the exponent (20), `(1+B7)^(12*A14)` loses part of its exponent,
 * `2^3^2` groups to the right (512), and `-2^2` negates after raising (-4). Before this, `^` had no
 * rule at all and the exponent was silently dropped: `=2^3` was 2.
 *
 * Rewriting to POWER reuses its exact Decimal arithmetic and follows Excel's rules: `^` groups to
 * the left (`2^3^2` is 64) and a leading unary minus belongs to the base (`-2^2` is 4). An operand is
 * a number, reference, function call, parenthesised group or string, with any unary signs before it
 * and a postfix `%` after it.
 */
const OPERAND_CHAR = /[A-Z0-9_.:]/;
const PRECEDES_UNARY = /[=(,<>+\-*/^&!]/;

const operandStart = (text: string, end: number): number => {
  let i = end;
  while (i >= 0 && text[i] === " ") i--;
  while (i >= 0 && text[i] === "%") { i--; while (i >= 0 && text[i] === " ") i--; }
  if (text[i] === ")") {
    let depth = 0;
    for (; i >= 0; i--) {
      if (text[i] === ")") depth++;
      else if (text[i] === "(" && --depth === 0) break;
    }
    i--;
    while (i >= 0 && OPERAND_CHAR.test(text[i])) i--;  // the callee, if this is a call
  } else if (isQuoteChar(text[i])) {
    const q = text[i];
    i--;
    while (i >= 0 && text[i] !== q) i--;
    i--;
  } else {
    while (i >= 0 && OPERAND_CHAR.test(text[i])) i--;
  }
  let start = i + 1;
  // Unary signs bind tighter than `^` in Excel, so they belong to the base.
  for (;;) {
    let j = start - 1;
    while (j >= 0 && text[j] === " ") j--;
    if (j < 1 || (text[j] !== "-" && text[j] !== "+")) break;
    let k = j - 1;
    while (k >= 0 && text[k] === " ") k--;
    if (k >= 0 && !PRECEDES_UNARY.test(text[k])) break;
    start = j;
  }
  return start;
};

const operandEnd = (text: string, begin: number): number => {
  let i = begin;
  while (i < text.length && (text[i] === " " || text[i] === "-" || text[i] === "+")) i++;
  if (isQuoteChar(text[i])) {
    const q = text[i];
    i++;
    while (i < text.length && text[i] !== q) i++;
    i++;
  } else {
    while (i < text.length && OPERAND_CHAR.test(text[i])) i++;
    let j = i;
    while (j < text.length && text[j] === " ") j++;
    if (text[j] === "(") {
      const close = matchParen(text, j);
      i = close < 0 ? text.length : close + 1;
    }
  }
  let j = i;
  while (j < text.length && (text[j] === " " || text[j] === "%")) j++;
  return text[j - 1] === "%" ? j : i;
};

/** The index of the first `^` outside quoted text, or -1. */
const firstCaret = (text: string): number => {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = ""; }
    else if (isQuoteChar(c)) quote = c;
    else if (c === "^") return i;
  }
  return -1;
};

const spellPower = (text: string): string => {
  // Leftmost first, so the result becomes the base of the next `^`: left-associative.
  for (let at = firstCaret(text); at > 0; at = firstCaret(text)) {
    const start = operandStart(text, at - 1);
    const end = operandEnd(text, at + 1);
    const base = text.slice(start, at).trim();
    const exponent = text.slice(at + 1, end).trim();
    if (!base || !exponent) break;  // malformed; leave it for the parser to report
    text = `${text.slice(0, start)}POWER(${base},${exponent})${text.slice(end)}`;
  }
  return text;
};

/**
 * Upper-case a formula, drop `$` anchors (see stripAbsoluteReferences), spell `<>` as `!=` and
 * `a^b` as `POWER(a,b)`, and bracket any function call that is an operand of `*` or `/`.
 *
 * THIS IS STILL NEEDED, and it is worth being clear why, because the rest of
 * this file just got much smaller and it would be easy to assume this went too.
 * The defect is in parselatex, not translatex: application by juxtaposition is
 * assembled at the LOWEST multiplicative precedence, so every explicit
 * multiplicative operator binds tighter and closes over the bare callee.
 *
 *     =A1/SUM(A1,A2)     the call is lost
 *     =SUM(A1,A2)/A1     the argument list becomes the numerator, and it throws
 *     =SUM(A1,A2)*A1     parses correctly
 *
 * parselatex 1.8.0 fixes this properly, with a real application production —
 * but only for a caller that declares its function names as `{type:'function'}`
 * in env, and translatex 0.25.0 does not. When it does, every case below
 * becomes a test of the parser fix and this function can go.
 *
 * A redundant pair of brackets is the whole workaround: `=A1/(SUM(A1,A2))`
 * evaluates correctly. Every call that is an operand of `*` or `/` is
 * bracketed, rather than only the three of those four positions that are
 * broken — `=SUM(A1,A2)*A1` already parses, and brackets leave it alone. The
 * scan is left to right and bracketing does not skip the bracketed region, so a
 * call nested inside another call is reached on the same pass.
 */
export const prepareFormula = (text: any): string => {
  const upper = spellPower(spellNotEqual(toUpperCase(stripAbsoluteReferences(text))));
  if (!upper || upper.indexOf("=") !== 0 || !/[*/+-]/.test(upper)) return upper;

  /** The next character that is not a space, from `i` on. */
  const significantAt = (i: number) => {
    while (i < upper.length && upper[i] === " ") i++;
    return upper[i] || "";
  };
  const isMulDiv = (c: string) => c === "*" || c === "/";
  // A sign before a call breaks the same way: `=-SUM(A1,A2)` was the text "0A1…A2", and
  // `=A1+-SUM(A1,A2)` dropped the call. After a binary `+`/`-` the brackets are redundant.
  const isSign = (c: string) => c === "+" || c === "-";

  // index of a `)` -> how many extra `)` to emit after it.
  const extraClose = new Map<number, number>();
  let out = "";
  let inString = false;
  let prev = "";  // last significant character outside a string

  for (let i = 0; i < upper.length; i++) {
    const c = upper[i];
    if (isQuoteChar(c)) { inString = !inString; out += c; prev = c; continue; }
    if (inString) { out += c; continue; }

    if (/[A-Z]/.test(c) && (prev === "" || !/[A-Z0-9_]/.test(prev))) {
      let j = i;
      while (j < upper.length && /[A-Z0-9_]/.test(upper[j])) j++;
      let open = j;
      while (open < upper.length && upper[open] === " ") open++;
      if (upper[open] === "(" && FN_NAMES.has(upper.slice(i, j))) {
        const end = matchParen(upper, open);
        if (end >= 0 && (isMulDiv(prev) || isSign(prev) || isMulDiv(significantAt(end + 1)))) {
          out += "(";
          extraClose.set(end, (extraClose.get(end) || 0) + 1);
        }
      }
    }

    out += c;
    if (c === ")") out += ")".repeat(extraClose.get(i) || 0);
    if (c !== " ") prev = c;
  }
  return out;
};
