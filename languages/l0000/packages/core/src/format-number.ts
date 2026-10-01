// SPDX-License-Identifier: MIT
//
// `format-number`: a number as text, by an Excel number-format pattern. The supported
// subset, and what is reported as an error instead of ignored, is in spec/spec.md under
// `format-number`.
//
// Arithmetic is decimal (decimal.js), never binary: a JS number is read from its shortest
// decimal (`1.005` is 1.005, so `"0.00"` gives "1.01" where toFixed gives "1.00"), and a
// Decimal keeps every digit. Rounding is half away from zero, as in Excel.

import DecimalImport from "decimal.js";
// See the same normalization in compiler.ts: decimal.js is consumed as both CJS and ESM.
const DecimalBase: any = (DecimalImport as any)?.default ?? DecimalImport;
// Enough precision that `%` and the scaling commas never round a literal's digits (a
// literal can carry hundreds: the exact expansion of 1.7e308 has 309).
const D: any = DecimalBase.clone({ precision: 1000, rounding: DecimalBase.ROUND_HALF_UP });

export class FormatPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatPatternError";
  }
}

type Placeholder = "0" | "#" | "?";

type Token =
  | { t: "ph"; c: Placeholder }
  | { t: "dot" }
  | { t: "comma"; role?: "group" | "scale" | "lit" }
  | { t: "pct" }
  | { t: "exp"; letter: string; sign: "+" | "-" }
  | { t: "general" }
  | { t: "lit"; s: string };

type Section = {
  tokens: Token[];
  general: boolean;
  intPh: Placeholder[];
  fracPh: Placeholder[];
  expPh: Placeholder[];
  exp: { letter: string; sign: "+" | "-" } | null;
  hasDot: boolean;
  grouping: boolean;
  scale: number; // thousands, one per scaling comma
  pct: number; // hundreds, one per %
};

const PLACEHOLDERS = new Set(["0", "#", "?"]);
const isPlaceholder = (c: string | undefined): c is Placeholder => c !== undefined && PLACEHOLDERS.has(c);

function tokenize(pattern: string): Token[][] {
  const sections: Token[][] = [[]];
  let tokens = sections[0];
  let hasDot = false;
  let hasExp = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    const next = pattern[i + 1];
    if (c === ";") {
      tokens = [];
      sections.push(tokens);
      hasDot = false;
      hasExp = false;
    } else if (c === "\"") {
      const end = pattern.indexOf("\"", i + 1);
      if (end === -1) throw new FormatPatternError("a quoted string is not closed");
      tokens.push({ t: "lit", s: pattern.slice(i + 1, end) });
      i = end;
    } else if (c === "\\" || c === "_" || c === "*") {
      if (next === undefined) throw new FormatPatternError(`'${c}' at the end of the pattern needs a character after it`);
      // \c is c; _c is a space as wide as c; *c repeats c to fill a cell, and there is no cell.
      if (c === "\\") tokens.push({ t: "lit", s: next });
      if (c === "_") tokens.push({ t: "lit", s: " " });
      i++;
    } else if (isPlaceholder(c)) {
      tokens.push({ t: "ph", c });
    } else if (c === ".") {
      // The first decimal point of the mantissa is the decimal point; any other is text.
      tokens.push(hasDot || hasExp ? { t: "lit", s: "." } : { t: "dot" });
      hasDot = true;
    } else if (c === ",") {
      tokens.push({ t: "comma" });
    } else if (c === "%") {
      tokens.push({ t: "pct" });
    } else if ((c === "E" || c === "e") && !hasExp &&
               (isPlaceholder(next) || ((next === "+" || next === "-") && isPlaceholder(pattern[i + 2])))) {
      // E+00 always writes the exponent's sign; E-00, and the unsigned E00, only a minus.
      const sign = next === "+" ? "+" : "-";
      tokens.push({ t: "exp", letter: c, sign });
      if (next === "+" || next === "-") i++;
      hasExp = true;
    } else if (/^general/i.test(pattern.slice(i))) {
      tokens.push({ t: "general" });
      i += "general".length - 1;
    } else if (c === "[") {
      throw new FormatPatternError("[…] (colors, conditions and locales) is not supported");
    } else if (c === "@") {
      throw new FormatPatternError("@ (text sections) is not supported");
    } else if (c === "/" && tokens[tokens.length - 1]?.t === "ph" && (isPlaceholder(next) || /[0-9]/.test(next ?? ""))) {
      throw new FormatPatternError("fractions (/ between digit placeholders) are not supported");
    } else if (/[a-zA-Z]/.test(c)) {
      throw new FormatPatternError(/[ymdhsYMDHS]/.test(c)
        ? `'${c}': date and time codes are not supported`
        : `'${c}': put literal text in double quotes`);
    } else if (/[1-9]/.test(c)) {
      throw new FormatPatternError(`'${c}': put literal digits in double quotes`);
    } else {
      tokens.push({ t: "lit", s: c });
    }
  }
  return sections;
}

function analyze(tokens: Token[]): Section {
  const general = tokens.some(tk => tk.t === "general");
  const expIdx = tokens.findIndex(tk => tk.t === "exp");
  const mantissaEnd = expIdx === -1 ? tokens.length : expIdx;
  const dotIdx = tokens.findIndex(tk => tk.t === "dot");
  const intEnd = dotIdx === -1 ? mantissaEnd : dotIdx;
  const phAt = (i: number) => tokens[i]?.t === "ph";
  const anyPh = (from: number, to: number) => tokens.slice(from, to).some(tk => tk.t === "ph");

  if (general && tokens.some(tk => tk.t === "ph")) {
    throw new FormatPatternError("General cannot be combined with digit placeholders");
  }

  let grouping = false;
  let scale = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.t !== "comma") continue;
    if (i < intEnd && anyPh(0, i) && anyPh(i + 1, intEnd)) {
      tk.role = "group"; // #,##0
      grouping = true;
      continue;
    }
    // A run of commas right after the mantissa's last digits divides by 1000 each: #,##0,,
    let before = i - 1;
    while (tokens[before]?.t === "comma") before--;
    let after = i + 1;
    while (tokens[after]?.t === "comma") after++;
    const nextTk = tokens[after];
    if (i < mantissaEnd && phAt(before) &&
        (nextTk === undefined || nextTk.t === "dot" || nextTk.t === "exp" || !anyPh(after, mantissaEnd))) {
      tk.role = "scale";
      scale++;
    } else {
      tk.role = "lit";
    }
  }

  const phs = (from: number, to: number) =>
    tokens.slice(from, to).flatMap(tk => (tk.t === "ph" ? [tk.c] : []));
  return {
    tokens,
    general,
    intPh: phs(0, intEnd),
    fracPh: dotIdx === -1 ? [] : phs(dotIdx + 1, mantissaEnd),
    expPh: expIdx === -1 ? [] : phs(expIdx + 1, tokens.length),
    exp: expIdx === -1 ? null : tokens[expIdx] as { letter: string; sign: "+" | "-" },
    hasDot: dotIdx !== -1,
    grouping,
    scale,
    pct: tokens.filter(tk => tk.t === "pct").length,
  };
}

const cache = new Map<string, Section[]>();

export function parsePattern(pattern: string): Section[] {
  const hit = cache.get(pattern);
  if (hit) return hit;
  if (pattern === "") throw new FormatPatternError("the pattern is empty");
  const sections = tokenize(pattern);
  if (sections.length > 3) {
    throw new FormatPatternError("at most three sections (positive;negative;zero); a fourth, text section is not supported");
  }
  const parsed = sections.map(analyze);
  if (cache.size >= 500) cache.clear();
  cache.set(pattern, parsed);
  return parsed;
}

// Digits right-aligned into placeholders: extra digits go to the leftmost one, and an
// unfilled `0` shows 0, `?` a space and `#` nothing. Returns one string per placeholder.
function fillInteger(digits: string, phs: Placeholder[], grouping: boolean): string[] {
  const n = phs.length;
  const slots: string[][] = phs.map(() => []);
  for (let j = n - 1, k = digits.length - 1; j >= 0; j--) {
    if (k >= 0) {
      slots[j].push(digits[k--]);
      if (j === 0) while (k >= 0) slots[0].unshift(digits[k--]);
    } else {
      slots[j].push(phs[j] === "0" ? "0" : phs[j] === "?" ? " " : "");
    }
  }
  if (grouping) {
    // A comma before every third digit from the right that has a digit to its left.
    const cells: { slot: number; i: number }[] = [];
    slots.forEach((chars, slot) => chars.forEach((_, i) => cells.push({ slot, i })));
    let count = 0;
    for (let x = cells.length - 1; x >= 0; x--) {
      const { slot, i } = cells[x];
      if (!/[0-9]/.test(slots[slot][i])) continue;
      if (count > 0 && count % 3 === 0) slots[slot][i] = slots[slot][i] + ",";
      count++;
    }
  }
  return slots.map(chars => chars.join(""));
}

// Trailing zeros under `#` are dropped and under `?` become spaces; `0` always shows.
function fillFraction(digits: string, phs: Placeholder[]): string[] {
  const out = phs.map((_, j) => digits[j]);
  for (let j = phs.length - 1; j >= 0 && digits[j] === "0" && phs[j] !== "0"; j--) {
    out[j] = phs[j] === "?" ? " " : "";
  }
  return out;
}

function render(section: Section, value: any): { text: string; nonzero: boolean } {
  if (section.general) {
    const text = section.tokens.map(tk => (tk.t === "general" ? value.toString() : tk.t === "lit" ? tk.s : "")).join("");
    return { text, nonzero: !value.isZero() };
  }
  let v = value.times(new D(100).pow(section.pct)).dividedBy(new D(1000).pow(section.scale));
  const f = section.fracPh.length;
  let exponent = 0;
  if (section.exp) {
    // As many integer digits as `0` placeholders; with any `#`, the exponent is a multiple
    // of the integer placeholder count instead (engineering form, ##0.0E+0).
    const k = Math.max(1, section.intPh.length);
    const engineering = section.intPh.includes("#");
    const exponentFor = (x: any) => (x.isZero() ? 0 : engineering ? Math.floor(x.e / k) * k : x.e - (k - 1));
    exponent = exponentFor(v);
    let m = v.times(new D(10).pow(-exponent)).toDecimalPlaces(f);
    if (!m.isZero() && exponentFor(m) !== 0) { // rounding carried into a new digit: 9.99 → 10.0
      exponent += exponentFor(m);
      m = v.times(new D(10).pow(-exponent)).toDecimalPlaces(f);
    }
    v = m;
  }
  const fixed = v.toFixed(f);
  const [intPart, fracPart = ""] = fixed.split(".");
  const intDigits = intPart === "0" ? "" : intPart;
  const nonzero = /[1-9]/.test(intPart + fracPart);

  const intSlots = fillInteger(intDigits, section.intPh, section.grouping && !section.exp);
  const fracSlots = fillFraction(fracPart, section.fracPh);
  const expDigits = String(Math.abs(exponent));
  const expSlots = fillInteger(expDigits === "0" ? "" : expDigits, section.expPh, false);

  let text = "";
  let inExp = false;
  let intIdx = 0;
  let fracIdx = 0;
  let expIdx = 0;
  let pastDot = false;
  for (const tk of section.tokens) {
    if (tk.t === "ph") {
      text += inExp ? expSlots[expIdx++] : pastDot ? fracSlots[fracIdx++] : intSlots[intIdx++];
    } else if (tk.t === "dot") {
      // With no integer placeholders, the integer digits still come before the point.
      if (section.intPh.length === 0) text += intDigits;
      text += ".";
      pastDot = true;
    } else if (tk.t === "exp") {
      text += tk.letter + (exponent < 0 ? "-" : tk.sign === "+" ? "+" : "");
      inExp = true;
    } else if (tk.t === "pct") {
      text += "%";
    } else if (tk.t === "comma") {
      if (tk.role === "lit") text += ",";
    } else if (tk.t === "lit") {
      text += tk.s;
    }
  }
  return { text, nonzero };
}

/**
 * `value` (a JS number or a Decimal) as text, by an Excel number-format `pattern`. Throws
 * FormatPatternError for a pattern outside the supported subset, and RangeError for a
 * value that is not finite.
 */
export function formatNumber(pattern: string, value: number | object): string {
  const sections = parsePattern(pattern);
  const v = new D(DecimalBase.isDecimal(value) ? (value as any).toString() : value);
  if (!v.isFinite()) throw new RangeError(`cannot format ${v.toString()}`);
  if (sections.length === 1) {
    // One section: a minus is written only when the rounded result is not zero.
    const { text, nonzero } = render(sections[0], v.abs());
    return v.isNegative() && nonzero ? "-" + text : text;
  }
  // Sections are chosen by the unrounded value, as in Excel; a negative one writes no minus.
  const section = v.isNegative() && !v.isZero() ? sections[1]
    : v.isZero() && sections.length === 3 ? sections[2]
      : sections[0];
  return render(section, v.abs()).text;
}
