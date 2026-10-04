// SPDX-License-Identifier: MIT
/**
 * Date patterns for `format`, which L0000's formatNumber does not do ("date and time codes are not
 * supported"). Excel's codes, so one pattern language covers numbers and dates:
 *   yyyy yy · mmmm mmm mm m · dddd ddd dd d · hh h · mm m (minutes, after h or before s) · ss s ·
 *   AM/PM. Text in "quotes" or after \ is literal.
 * Always UTC, so a program formats the same wherever it compiles.
 *
 * What counts as a date: a number is a Unix time — milliseconds, or seconds when it is below 1e11
 * (1e11 ms is March 1973; 1e11 s is the year 5138, so the two ranges do not meet in real data). A
 * string is a date when Date.parse reads it (ISO 8601, e.g. "2024-11-03" or "2024-11-03T10:15Z").
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A pattern is a date pattern when, outside quoted text, it uses y, d, h or s. */
export function isDatePattern(pattern: string): boolean {
  return /[ydhs]/i.test(pattern.replace(/"[^"]*"|\\./g, ""));
}

/** The date a value stands for, or null. */
export function toDate(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(Math.abs(value) < 1e11 ? value * 1000 : value);
  }
  if (typeof value === "string" && value.trim()) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : new Date(t);
  }
  return null;
}

type Token = { code: string } | { text: string };

function tokenize(pattern: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '"') {
      const end = pattern.indexOf('"', i + 1);
      out.push({ text: pattern.slice(i + 1, end < 0 ? undefined : end) });
      i = end < 0 ? pattern.length : end + 1;
    } else if (c === "\\") {
      out.push({ text: pattern[i + 1] ?? "" });
      i += 2;
    } else if (/^am\/pm/i.test(pattern.slice(i))) {
      out.push({ code: "AM/PM" });
      i += 5;
    } else if (/[ymdhs]/i.test(c)) {
      let j = i;
      while (j < pattern.length && pattern[j].toLowerCase() === c.toLowerCase()) j++;
      out.push({ code: pattern.slice(i, j).toLowerCase() });
      i = j;
    } else {
      out.push({ text: c });
      i++;
    }
  }
  return out;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Format a date with an Excel date pattern, in UTC. */
export function formatDate(pattern: string, date: Date): string {
  const tokens = tokenize(pattern);
  const codes = tokens.filter((t): t is { code: string } => "code" in t);
  const ampm = codes.some((t) => t.code === "AM/PM");
  return tokens
    .map((t) => {
      if ("text" in t) return t.text;
      const { code } = t;
      // Excel's rule: m/mm right after an hour code, or right before a seconds code, is minutes.
      if (code === "m" || code === "mm") {
        const k = codes.indexOf(t);
        const minutes = codes[k - 1]?.code.startsWith("h") || codes[k + 1]?.code.startsWith("s");
        if (minutes) return code === "mm" ? pad(date.getUTCMinutes()) : String(date.getUTCMinutes());
      }
      const hour12 = date.getUTCHours() % 12 || 12;
      switch (code) {
        case "yyyy": case "yyy": return String(date.getUTCFullYear());
        case "yy": case "y": return pad(date.getUTCFullYear() % 100);
        case "mmmmm": return MONTHS[date.getUTCMonth()][0];
        case "mmmm": return MONTHS[date.getUTCMonth()];
        case "mmm": return MONTHS[date.getUTCMonth()].slice(0, 3);
        case "mm": return pad(date.getUTCMonth() + 1);
        case "m": return String(date.getUTCMonth() + 1);
        case "dddd": return DAYS[date.getUTCDay()];
        case "ddd": return DAYS[date.getUTCDay()].slice(0, 3);
        case "dd": return pad(date.getUTCDate());
        case "d": return String(date.getUTCDate());
        case "hh": return pad(ampm ? hour12 : date.getUTCHours());
        case "h": return String(ampm ? hour12 : date.getUTCHours());
        case "ss": return pad(date.getUTCSeconds());
        case "s": return String(date.getUTCSeconds());
        case "AM/PM": return date.getUTCHours() < 12 ? "AM" : "PM";
        default: return code;
      }
    })
    .join("");
}
