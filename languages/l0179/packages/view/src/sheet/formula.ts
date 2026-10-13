// SPDX-License-Identifier: MIT
/**
 * The spreadsheet engine: evaluate a cell, work out what it depends on, catch cycles, and format
 * the result for display.
 *
 * Lifted VERBATIM out of TableEditor.tsx, where it sat among 1,400 lines of ProseMirror plumbing
 * while importing none of it. It operates on a plain environment —
 * `{ cells: { [name]: { text, val, formula, type, format, deps } } }` — and returns plain values.
 *
 * Two reasons it lives here now. First, it is the half of the grid that survives any renderer, and
 * keeping it separate is what makes replacing the renderer a re-skin rather than a rewrite; this is
 * the same split already made for scoring (see ../scoring/score.ts). Second, and more immediately:
 * while it was tangled in the editor it had NO TESTS AT ALL. Formula evaluation, the dependency
 * graph, cycle detection and every date and number format were pinned only by the source.
 *
 * `#NAME!` and `#CYCLE!` are produced here, before evaluation, and carry a human-readable `error`.
 */
import { TransLaTeX } from "@graffiticode/translatex";

import { formatRules } from "../scoring/translatex-rules.js";
import { evalRules, expanders, prepareFormula, bindStringLiterals } from "../scoring/translatex-extensions.js";
import { spreadsheetErrorMarker } from "@graffiticode/translatex/src/spreadsheet.js";
import {
  stripAbsoluteReferences,
  isNumeric,
  wrapPlainTextInLatex,
  classifyInput,
  isDayFirst,
} from "../scoring/index.js";
import { findCycle, findCycleWith, lazyPrecedents, getSingleCellDependencies } from "./graph.js";
import { evalKey, cacheGet, cacheSet, formatKey, formatCacheGet, formatCacheSet } from "./cache.js";
import type { DependencyGraph } from "./graph.js";

/**
 * What a cell evaluates to. `error` is present only on the error path, where `val` carries the
 * spreadsheet-visible marker (`#NAME!`, `#CYCLE!`) and `error` the human-readable reason.
 */
export interface CellValue {
  formula: any;
  val: any;
  format: any;
  type: string;
  error?: string;
}

/** A spreadsheet error value, as a function returns it. */
const ERROR_MARKER = /^#(VALUE!|NUM!|DIV\/0!|NAME\?|NAME!|REF!|N\/A|NULL!)$/;

export const evalCell = ({ env, name, graph, cache }: any): CellValue => {
  const cell = env.cells[name];
  const text = cell?.text || "";
  const format = cell?.format || "";
  let result = {
    formula: text,
    val: text,
    format: format,
    type: 'text', // Default type is text
  };

  // Check for undefined function references and cycles before evaluation for formulas
  if (text && text.length > 0 && text.indexOf("=") === 0) {
    // Check for undefined name references (functions or variables)
    const supportedFunctions = evalRules.types.fn;
    const namePattern = /([A-Za-z][A-Za-z0-9_]*)/g;
    const cellNamePattern = /^[A-Za-z]+[0-9]+$/; // Pattern for valid cell names like A1, B2, AA10
    // Blank the quoted segments first. WITHOUT THIS the scan reads inside
    // string literals and calls their words undefined names, so
    // `=IF(A1,"Yes","No")` reported `Undefined names: Yes, No` — and worse, it
    // MASKED the real error: the parser rejected a double quote outright with a
    // clean 1004, and this returned a wrong #NAME! before that could surface.
    // (Literals are now bound before parsing — see bindStringLiterals.)
    // Same treatment sheet/graph.ts already gives dependency extraction.
    // `$B$6` is B6; unstripped, the scan reads the bare `B` as an undefined name.
    const scannable = stripAbsoluteReferences(text)
      .replace(/"[^"]*"/g, '""')
      .replace(/'[^']*'/g, "''");
    let match;
    const undefinedNames = [];
    while ((match = namePattern.exec(scannable)) !== null) {
      const name = match[1];
      const nameLower = name.toLowerCase();
      // Skip if it's a valid cell reference (letters followed by numbers)
      if (cellNamePattern.test(name)) {
        continue;
      }
      // Skip if it's a supported function
      if (supportedFunctions.includes(nameLower)) {
        continue;
      }
      // It's an undefined name
      undefinedNames.push(name);
    }
    if (undefinedNames.length > 0) {
      const uniqueNames = [...new Set(undefinedNames)]; // Remove duplicates
      return {
        formula: text,
        val: "#NAME!",
        format: format,
        type: 'error',
        error: `Undefined name${uniqueNames.length > 1 ? 's' : ''}: ${uniqueNames.join(', ')}`
      };
    }

    const cycleCheck = detectCycles({ env, startCell: name, graph });
    if (cycleCheck.hasCycle) {
      return {
        formula: text,
        val: "#CYCLE!",
        format: format,
        type: 'error',
        error: `Circular dependency: ${cycleCheck.cyclePath?.join(' → ')}`
      };
    }
  }

  // Apply normalization for non-formula input. The cell's format decides what `3/4` is: a date
  // in a date-formatted cell (this year, day-first if the format is), otherwise a fraction.
  if (text && !text.startsWith('=')) {
    const classified = classifyInput(text, { date: isDateFormat(format), dayFirst: isDayFirst(format) });
    if (classified) {
      result.val = classified.val;
      result.type = classified.type;
    }
  }
  try {
    // Only process formulas through TransLaTeX
    if (text && text.length > 0 && text.indexOf("=") === 0) {
      // Only the cells this formula actually references are handed to the parser.
      //
      // This is not merely an allocation saving. `Object.keys(env)` becomes parselatex's
      // identifier table, and it is scanned per character of every identifier token, so the parse
      // gets slower the bigger the env is: the same `=SUM(A1:A3)+B1` measures 6.1 ms against four
      // cells and 32.3 ms against 1206.
      //
      // The `!== undefined` filter is what makes it SAFE. Membership changes the parse, not just
      // the lookup — `=A1+Q7` is "11" when Q7 is in the env and "10" when it is absent — so a
      // referenced name is included exactly when it exists in the source map, which reproduces the
      // identifier set the whole map would have produced for this formula. Dropping names the
      // formula does not mention cannot change anything, which is the half that buys the speed.
      const deps = graph
        ? (graph.precedents.get(name) || [])
        : getSingleCellDependencies({ env, name });
      const narrowEnv: any = {};
      for (const dep of deps) {
        const cell = env.cells[dep];
        if (cell !== undefined) narrowEnv[dep] = cell;
      }

      const key = cache && evalKey(env.cells, name, deps);
      const hit = cache && cacheGet(cache, key);
      if (hit) return hit;

      // String literals become synthetic references the parser can read; see bindStringLiterals.
      const literals = bindStringLiterals(text);
      if (literals.error) {
        result = { ...result, val: "#VALUE!", type: 'error', error: literals.error } as any;
        return cache ? cacheSet(cache, key, result) : result;
      }
      Object.assign(narrowEnv, literals.env);
      const options = {
        // allowThousandsSeparator: true,
        keepTextWhitespace: true,
        env: narrowEnv,
        ...evalRules,
      };
      const processedText = prepareFormula(literals.text);
      const translate = TransLaTeX.buildTranslator(options, expanders);
      translate(processedText, (err, val) => {
        if (err && err.length) {
          // A translation error is now REPORTED, not logged and discarded.
          //
          // It used to fall through to `val`, which is "" on the error path, so
          // an unparseable formula produced a silently EMPTY cell — the same
          // silent-wrong-answer class as the rest of this work. It went
          // unnoticed because the #NAME! pre-scan above happened to catch the
          // common cases first, and, for a formula containing a string, caught
          // it WRONGLY: it reported the string's words as undefined names and
          // masked the real 1004 underneath.
          //
          // Codes translatex names get their spreadsheet marker from it;
          // anything else (1001/1003/1004 are the parser's syntax codes) shows
          // #NAME!, which is what this cell displayed before and what Excel
          // shows for text it cannot resolve in a formula.
          const first: any = err[0];
          const code = first && first.errorCode;
          result = {
            ...result,
            val: spreadsheetErrorMarker(code) || "#NAME!",
            type: 'error',
            error: String(first && first.message ? first.message : first),
          } as any;
          return;
        }
        val = literals.decode(val);
        // A function that reports an error returns its marker (POWER's #NUM!, ABS's #VALUE!).
        if (typeof val === "string" && ERROR_MARKER.test(val)) {
          result = { ...result, val, type: 'error', error: `${val} returned by the formula` } as any;
          return;
        }
        // Store val as string but set appropriate type
        // Check if it's a date format first
        if (isDateFormat(format) && isNumeric(String(val))) {
          result = {
            ...result,
            val: String(val),
            type: 'date',
          };
        }
        // Check if it's a number
        else if (isNumeric(String(val))) {
          result = {
            ...result,
            val: String(val),
            type: 'number',
          };
        }
        // Otherwise it's text
        else {
          result = {
            ...result,
            val: String(val),
            type: 'text',
          };
        }
      });
      if (cache) return cacheSet(cache, key, result);
    }
  } catch (x: any) {
    console.log("parse error: " + x.stack);
  }
  return result;
}

export const fixText = text => {
  // Convert to string if not already
  const str = typeof text === 'string' ? text : String(text || '');
  return str
    .replace(new RegExp("\\{\\{", "g"), "[[")
    .replace(new RegExp("\\}\\}", "g"), "]]");
};

export const isDateFormat = (format) => {
  const dateFormatPatterns = [
    'MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD',
    'MM-DD-YYYY', 'DD-MM-YYYY', 'M/D/YY', 'D/M/YY',
    'MMM DD, YYYY', 'DD MMM YYYY', 'date'
  ];
  return format && dateFormatPatterns.some(pattern =>
    format.toLowerCase().includes(pattern.toLowerCase())
  );
};

export const formatCellValue = ({ env, name, cache }: any) => {
  const cell = env.cells[name] || {};
  // A pure function of the cell's `val`, `type` and `format` — see formatKey. Formats repeat
  // heavily across a real sheet, so this is nearly all hits once warm.
  const key = cache && formatKey(cell);
  if (cache) {
    const hit = formatCacheGet(cache, key);
    if (hit !== undefined) return hit;
  }
  const val = cell.val;
  const type = cell.type || 'text';
  const format = cell.format || "";
  // A fraction shows as the learner typed it (`3/4`, not 0.75) unless a format says otherwise.
  let result = type === 'fraction' && !format ? (cell.formula ?? cell.text ?? val) : val;

  // Handle date serial numbers based on type and format
  const isDateFormatted = isDateFormat(format);
  // Convert string val to number if it's a date type
  if ((type === 'date' || isDateFormatted) && val) {
    const numVal = typeof val === 'string' ? parseFloat(val) : val;
    if (!isNaN(numVal)) {
      // Back from calendar days in UTC, as normalize.ts counts them, and read in UTC below — a
      // local-time round trip lost a day on every date inside daylight saving.
      const msPerDay = 24 * 60 * 60 * 1000;
      const utc = new Date(Date.UTC(1904, 0, 1) + (numVal - 1) * msPerDay);
      const date = new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
    // Apply specific date format
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const year = date.getFullYear();
    const yearShort = year.toString().slice(-2);
    if (format.includes('DD/MM/YYYY')) {
      result = `${day.toString().padStart(2, '0')}/${month.toString().padStart(2, '0')}/${year}`;
    } else if (format.includes('DD-MM-YYYY')) {
      result = `${day.toString().padStart(2, '0')}-${month.toString().padStart(2, '0')}-${year}`;
    } else if (format.includes('YYYY-MM-DD')) {
      result = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    } else if (format.includes('MM-DD-YYYY')) {
      result = `${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}-${year}`;
    } else if (format.includes('M/D/YY')) {
      result = `${month}/${day}/${yearShort}`;
    } else if (format.includes('D/M/YY')) {
      result = `${day}/${month}/${yearShort}`;
    } else if (format.includes('MMM DD, YYYY')) {
      result = `${monthNames[date.getMonth()]} ${day.toString().padStart(2, '0')}, ${year}`;
    } else if (format.includes('DD MMM YYYY')) {
      result = `${day.toString().padStart(2, '0')} ${monthNames[date.getMonth()]} ${year}`;
    } else {
      // Default to MM/DD/YYYY
      result = `${month.toString().padStart(2, '0')}/${day.toString().padStart(2, '0')}/${year}`;
    }
    }
  }
  try {
    // Convert numbers to strings for TransLaTeX formatting
    if (typeof result === 'number' && format && !isDateFormatted) {
      result = result.toString();
    }
    // FIXME date formatting in translatex assumes input is a formatted string,
    // not a date serial number. For now, only process string values with format
    // rules (skip if we already formatted a date)
    if (format && result && typeof result === 'string' && result.length > 0 && !isDateFormatted) {
      const options = {
        allowInterval: true,
        keepTextWhitespace: true,
        RHS: false,
        env: {format},
        ...formatRules,
      };
      const processedVal = wrapPlainTextInLatex(result);
      const translate = TransLaTeX.buildTranslator(options, expanders);
      translate(processedVal, (err, val) => {
        if (err && err.length) {
          console.error(err);
        }
        result = val;
      });
    }
  } catch (x: any) {
    console.log("parse error: " + x.stack);
  }
  return cache ? formatCacheSet(cache, key, result) : result;
}


// Cycle detection using DFS with three-color approach
export interface CycleDetectionResult {
  hasCycle: boolean;
  cyclePath?: string[];
  dependencies: string[];
}

/**
 * Cycle detection from one cell.
 *
 * The traversal moved to `graph.ts`; this is the compatibility surface, unchanged in signature and
 * in output. What changed underneath is that the edges are parsed ONCE into a graph instead of the
 * DFS re-parsing every formula it walks — and a caller that already holds a graph can pass it and
 * skip the build entirely, which is what recalculation does.
 */
export const detectCycles = (
  { env, startCell, graph }: { env: any; startCell: string; graph?: DependencyGraph },
): CycleDetectionResult => (
  graph
    ? findCycle(graph, startCell)
    : findCycleWith(lazyPrecedents(env.cells), startCell)
);

/**
 * The cells `names` depend on, transitively, skipping any that sit in a cycle.
 *
 * One graph is built for the whole call rather than one DFS re-parsing per name, so N starts now
 * share the parse. The colour map stays PER START CELL inside `findCycle`: sharing it would mark
 * cells BLACK from an earlier walk and drop dependencies a later start is expected to report.
 */
export const getCellDependencies = ({ env, names, graph }: any) => {
  // One edge source for the whole call, so N starts share the parse of any cell they both reach.
  // Lazy when no graph was supplied: a caller asking about one name must not pay to parse the
  // entire sheet, which is exactly what the renderer does once per cell during a cold mount.
  const precedentsOf = graph
    ? (name: string) => graph.precedents.get(name) || []
    : lazyPrecedents(env.cells);
  const allDeps = new Set<string>();
  for (const name of names) {
    const result = findCycleWith(precedentsOf, name);
    if (result.hasCycle) {
      console.error(`Circular dependency detected in cell ${name}: ${result.cyclePath?.join(' → ')}`);
      // Continue processing other cells but don't add dependencies for cyclic cells
      continue;
    }
    result.dependencies.forEach(dep => allDeps.add(dep));
  }
  return Array.from(allDeps);
};

