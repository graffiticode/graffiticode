// SPDX-License-Identifier: MIT
/**
 * Value normalization, transcribed VERBATIM from L0166's TableEditor.tsx (lines 66-418).
 *
 * These are the functions that decide whether what a learner typed *means* the same thing as
 * what the author expected: "1,234.56", "$1234.56" and "1.234,56" are one number; "7/4/2024" and
 * "2024-07-04" are one date. Scoring is downstream of every one of them, so a difference here is
 * a difference in what gets marked right.
 *
 * Transcribed, not rewritten — the same rule that governs core's validation.ts and params.ts.
 * The quirks are load-bearing and are called out where they are not obvious:
 *   - dates use the 1904 epoch, which sidesteps Excel's 1900 leap-year bug;
 *   - `normalizeNumberInput` refuses text that merely STARTS with a number ("35% of total"),
 *     because those are prose, not values;
 *   - `normalizeDateInput` guards `Date.parse` with a character allowlist, because V8's parser is
 *     permissive enough to read "7-4=" as a date.
 *
 * No DOM, no React, no ProseMirror — see ./score.ts for why that matters.
 */

/** A quote character, for the string-aware upcaser below. */
const isQuoteChar = (c: string) => ["\"", "'", "`"].includes(c);

/**
 * Upper-case a formula WITHOUT touching quoted text: `=sum(a1:a3)` becomes `=SUM(A1:A3)`, but
 * `="hello"` keeps its string intact. Cell names and function names are case-insensitive; string
 * literals are not.
 */
export const toUpperCase = (text: any): string => {
  // Convert to string if it's not already
  if (typeof text !== "string") {
    text = text == null ? "" : String(text);
  }
  return (text && text.split("").reduce((acc: any, c: string) => ({
    inString: isQuoteChar(c) ? !acc.inString : acc.inString,
    text: acc.text + ((acc.inString && c) || c.toUpperCase()),
  }), { inString: false, text: "" }).text) || text;
};

/**
 * Drop the `$` anchors from absolute references outside quoted text: `=$B$4*B$6+$C7` becomes
 * `=B4*B6+C7`.
 *
 * Exact, not an approximation. `$` only changes what a reference becomes when a formula is copied
 * or filled, and a sheet here is authored cell by cell and never filled, so an anchored reference
 * always means the cell it names. It has to happen before anything reads references, because
 * nothing downstream understands `$`: the undefined-name scan read `$B$6` as the name `B`
 * (#NAME!), the dependency parser found no reference in it (so no recalculation), and the formula
 * parser read `$B6` as literal text.
 */
export const stripAbsoluteReferences = (text: any): any => {
  if (typeof text !== "string" || text.indexOf("$") < 0) return text;
  let out = "";
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (isQuoteChar(c)) {
      quote = c;
    } else if (c === "$" && (
      /^[A-Za-z]+\$?[0-9]/.test(text.slice(i + 1)) ||                           // $B$4, $B4
      (/[A-Za-z]/.test(text[i - 1] || "") && /[0-9]/.test(text[i + 1] || ""))  // B$4
    )) {
      continue;
    }
    out += c;
  }
  return out;
};

export const isNumeric = (text: any): boolean => {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  return !isNaN(Number(trimmed)) && !isNaN(parseFloat(trimmed));
};

export const isDateLike = (text: any): boolean => {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  // Check for common date patterns
  const datePatterns = [
    /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,  // MM/DD/YYYY or M/D/YY
    /^\d{1,2}-\d{1,2}-\d{2,4}$/,   // MM-DD-YYYY or M-D-YY
    /^\d{4}-\d{1,2}-\d{1,2}$/,     // YYYY-MM-DD
    /^\d{1,2}\/\d{1,2}$/,          // MM/DD
    /^\d{1,2}-\d{1,2}$/,           // MM-DD
  ];
  return datePatterns.some((pattern) => pattern.test(trimmed)) && !isNaN(Date.parse(trimmed));
};

/**
 * Wrap prose in `\text{}` so the LaTeX translator treats it as a string rather than as maths.
 * Formulas, existing `\text{}`, anything carrying a backslash, numbers and dates are left alone.
 */
export const wrapPlainTextInLatex = (text: any): string => {
  // Convert to string if it's not already
  if (typeof text !== "string") {
    text = text == null ? "" : String(text);
  }

  if (!text || text.length === 0) {
    return text;
  }
  // If it's a formula (starts with =), don't wrap
  if (text.indexOf("=") === 0) {
    return text;
  }
  // If it's already wrapped in \text{}, don't double wrap
  if (text.trim().startsWith("\\text{") && text.trim().endsWith("}")) {
    return text;
  }
  // If it contains LaTeX commands, don't wrap to avoid breaking them
  if (text.includes("\\")) {
    return text;
  }

  // If it's a pure number, don't wrap
  if (isNumeric(text)) {
    return text;
  }
  // If it's a pure date, don't wrap
  if (isDateLike(text)) {
    return text;
  }
  // Wrap everything else in \text{}
  return `\\text{${text}}`;
};

/**
 * Normalizes number input from various formats (e.g., "1,234.56", "$1234.56", "1.234,56")
 * into a standard numeric value.
 * @returns the normalized number, or null if not a valid number
 */
export const normalizeNumberInput = (text: any): number | null => {
  if (!text || typeof text !== "string") {
    return null;
  }
  let normalized = text.trim();
  if (!normalized) {
    return null;
  }

  // Check if this looks like text with a numeric prefix
  // e.g., "35% of total", "100 items", etc.
  // These should be treated as text, not numbers
  if (/%\s+\S/.test(normalized)) {
    // Has percentage followed by more text
    return null;
  }

  // Check for number followed by non-unit text
  const numberWithTextPattern = /^[\d,.$€£¥₹₽-]+\s+[a-zA-Z]{4,}/;
  if (numberWithTextPattern.test(normalized)) {
    // Has number followed by significant text (not just units)
    return null;
  }

  // Save original for parentheses check before removing them
  const originalNormalized = normalized;
  // Remove currency symbols
  const currencySymbols = ["$", "€", "£", "¥", "₹", "₽", "R$", "C$", "A$", "NZ$", "HK$", "S$"];
  currencySymbols.forEach((symbol) => {
    // Escape special regex characters
    const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    normalized = normalized.replace(new RegExp(escapedSymbol, "g"), "");
  });
  // Handle percentage (convert to decimal)
  const isPercentage = normalized.includes("%");
  normalized = normalized.replace(/%/g, "");
  // Handle negative numbers in parentheses e.g., (1,234.56) or ($1,234.56)
  const isNegativeParentheses = /^\s*\([^)]+\)\s*$/.test(originalNormalized) &&
        /\d/.test(originalNormalized);
  if (isNegativeParentheses) {
    normalized = normalized.replace(/[()]/g, "");
  }
  // Remove spaces
  normalized = normalized.replace(/\s/g, "");
  // Handle negative sign
  const isNegative = normalized.startsWith("-");
  if (isNegative) {
    normalized = normalized.substring(1);
  }
  // Determine decimal separator by analyzing the pattern
  const commaCount = (normalized.match(/,/g) || []).length;
  const periodCount = (normalized.match(/\./g) || []).length;
  const lastComma = normalized.lastIndexOf(",");
  const lastPeriod = normalized.lastIndexOf(".");
  let cleanedNumber;
  if (commaCount === 0 && periodCount === 0) {
    // No separators, just a plain number
    cleanedNumber = normalized;
  } else if (commaCount === 0 && periodCount === 1) {
    // Only one period, it's a decimal separator
    cleanedNumber = normalized;
  } else if (commaCount === 1 && periodCount === 0) {
    // Only one comma, check if it's likely a decimal
    const afterComma = normalized.substring(lastComma + 1);
    if (afterComma.length === 3 && normalized.length > 4) {
      // Likely thousand separator (e.g., "1,234")
      cleanedNumber = normalized.replace(/,/g, "");
    } else {
      // Likely decimal separator (e.g., "1,23" or "123,45")
      cleanedNumber = normalized.replace(",", ".");
    }
  } else if (lastComma > lastPeriod) {
    // Comma is after period, European format (e.g., "1.234,56")
    cleanedNumber = normalized.replace(/\./g, "").replace(",", ".");
  } else {
    // Period is after comma, US format (e.g., "1,234.56")
    cleanedNumber = normalized.replace(/,/g, "");
  }
  // Check if the result is a valid number (must parse the entire string)
  if (!isNumeric(cleanedNumber)) {
    return null;
  }
  const num = parseFloat(cleanedNumber);
  // Apply modifiers
  let result = num;
  // Apply negative
  if (isNegative || isNegativeParentheses) {
    result = -Math.abs(result);
  }
  // Apply percentage conversion
  if (isPercentage) {
    result = result / 100;
  }
  return result;
};

/**
 * Converts a Date object to an Excel serial number.
 * Uses the 1904 date system (Mac Excel) to avoid the 1900 leap year bug.
 * Excel serial dates start from January 1, 1904 as day 1.
 */
const dateToSerial = (date: Date): number => {
  // Calendar days, counted in UTC. Counted in local time, a date inside daylight saving is an
  // hour short of a whole number of days after the epoch, so it floored to the day BEFORE and
  // every summer date displayed a day early (`4/3/2026` showed `04/02/2026`).
  const msPerDay = 24 * 60 * 60 * 1000;
  const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((day - Date.UTC(1904, 0, 1)) / msPerDay) + 1;
};

/**
 * A fraction as a learner types one — `3/4`, `-3/4`, or Excel's mixed form `1 1/2` (and `0 3/4`,
 * Excel's way of forcing a fraction) — as its value, or null when the text is not one.
 *
 * In a cell with no date format this is read BEFORE any date: a learner answering "½ + ¼ =" types
 * `3/4` and means three quarters, and it was being read as 4 March. See `classifyInput`.
 */
export const parseFraction = (text: any): number | null => {
  if (typeof text !== "string") return null;
  const m = text.trim().match(/^(-)?(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/);
  if (!m) return null;
  const denominator = Number(m[4]);
  if (denominator === 0) return null;
  const value = Number(m[2] || 0) + Number(m[3]) / denominator;
  return m[1] ? -value : value;
};

/** Whether a date format puts the day first (`DD/MM/YYYY`, `D/M/YY`, `DD MMM YYYY`). */
export const isDayFirst = (format: any): boolean =>
  typeof format === "string" && /^\s*D/i.test(format);

/**
 * What typed text holds: `{type, val}` for a fraction, date or number, or null for plain text.
 * The one place input is classified, shared by the grid (what a learner typed, under the cell's
 * `format`) and the scorer (an `expected`, under the type the learner's cell resolved to) — so
 * the two can never disagree about what `3/4` means.
 *
 * `date` says the context is a date: a date-formatted cell, or an answer scored against a date.
 * Then `3/4` is a date, in the current year, day-first when `dayFirst`. Otherwise `3/4` is the
 * fraction three quarters — shown as typed, valued 0.75, so it equals `0.75` and `6/8`.
 */
export const classifyInput = (
  text: any,
  { date = false, dayFirst = false }: { date?: boolean; dayFirst?: boolean } = {},
): { type: "fraction" | "date" | "number"; val: string } | null => {
  if (!date) {
    const fraction = parseFraction(text);
    if (fraction !== null) return { type: "fraction", val: String(fraction) };
  }
  const serial = normalizeDateInput(text, { dayFirst });
  if (serial) return { type: "date", val: String(serial) };
  const number = normalizeNumberInput(text);
  if (number !== null) return { type: "number", val: String(number) };
  return null;
};

/**
 * Normalizes date input from various formats into a serial number.
 *
 * A date written without a year takes the CURRENT year, as a spreadsheet does. It used to reach
 * V8's `Date.parse` first, which fills a missing year with 2001 — `3/4` became 4 March 2001 and
 * displayed as `03/04/2001`. So a partial date is handled before `Date.parse`, and anything
 * `Date.parse` still completes without a four-digit year in the text gets this year instead.
 *
 * @returns the date serial number, or null if not a valid date
 */
export const normalizeDateInput = (
  text: any,
  { dayFirst = false }: { dayFirst?: boolean } = {},
): number | null => {
  if (!text || typeof text !== "string") {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  // Handle relative dates
  const today = new Date();
  const lowerText = trimmed.toLowerCase();
  if (lowerText === "today") {
    return dateToSerial(new Date(today.getFullYear(), today.getMonth(), today.getDate()));
  }
  if (lowerText === "tomorrow") {
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    return dateToSerial(new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate()));
  }
  if (lowerText === "yesterday") {
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    return dateToSerial(new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate()));
  }
  // Check if it's just a number (not a date)
  // This includes integers, decimals, and negative numbers
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return null;
  }
  // Check if it looks like a number with thousand separators or currency
  // e.g., "1,234" or "$1,234.56" or "€1.234,56"
  const currencyPattern = /^[$€£¥₹₽]?\s*-?\d{1,3}([,.]?\d{3})*([,.]\d+)?$|^-?\d{1,3}([,.]?\d{3})*([,.]\d+)?\s*[$€£¥₹₽%]?$/;
  if (currencyPattern.test(trimmed)) {
    return null;
  }
  // A day-first cell reads `3/4/2026` as 3 April, which Date.parse (month-first) would not.
  const numericDate = trimmed.match(/^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{4}))?$/);
  if (numericDate) {
    const [a, b] = [parseInt(numericDate[1], 10), parseInt(numericDate[2], 10)];
    let [month, day] = dayFirst ? [b, a] : [a, b];
    // Only one reading is a real date (`25/12` month-first): take it, as the old EU rule did.
    if (month > 12 && day <= 12) [month, day] = [day, month];
    const year = numericDate[3] ? parseInt(numericDate[3], 10) : today.getFullYear();
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return dateToSerial(new Date(year, month - 1, day));
    }
    return null;
  }
  // Try to parse various date formats
  // First, try native Date parsing for ISO and common formats.
  // V8's Date.parse is permissive (e.g. Date.parse("7-4=") returns a valid
  // timestamp). Guard with an allowlist of characters that can plausibly
  // appear in a date — digits, separators, spaces, ASCII letters for month
  // names — so things like "7-4=" or "2+3" never reach the lenient parser.
  if (/^[\dA-Za-z\s/\-.,:T]+$/.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    if (!isNaN(parsed)) {
      const date = new Date(parsed);
      // V8 fills a missing year with 2001 ("Mar 4" → 2001). No four-digit year written: this year.
      if (!/\d{4}/.test(trimmed)) date.setFullYear(today.getFullYear());
      return dateToSerial(date);
    }
  }
  // Handle MM/DD/YYYY, MM-DD-YYYY, MM.DD.YYYY
  const usDatePattern = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/;
  const usMatch = trimmed.match(usDatePattern);
  if (usMatch) {
    const month = parseInt(usMatch[1], 10);
    const day = parseInt(usMatch[2], 10);
    const year = parseInt(usMatch[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return dateToSerial(new Date(year, month - 1, day));
    }
  }
  // Handle DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY (European format)
  // Note: This could conflict with US format for ambiguous dates like 01/02/2023
  // You may want to make this configurable based on locale
  const euDatePattern = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/;
  const euMatch = trimmed.match(euDatePattern);
  if (euMatch) {
    const day = parseInt(euMatch[1], 10);
    const month = parseInt(euMatch[2], 10);
    const year = parseInt(euMatch[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && day > 12) {
      // Only use EU format if day > 12 to avoid ambiguity
      return dateToSerial(new Date(year, month - 1, day));
    }
  }
  // Handle MM/DD or MM-DD (current year implied)
  const partialDatePattern = /^(\d{1,2})[/-](\d{1,2})$/;
  const partialMatch = trimmed.match(partialDatePattern);
  if (partialMatch) {
    const month = parseInt(partialMatch[1], 10);
    const day = parseInt(partialMatch[2], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return dateToSerial(new Date(today.getFullYear(), month - 1, day));
    }
  }
  // Handle YYYY-MM-DD (ISO format)
  const isoPattern = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
  const isoMatch = trimmed.match(isoPattern);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10);
    const day = parseInt(isoMatch[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return dateToSerial(new Date(year, month - 1, day));
    }
  }
  return null;
};
