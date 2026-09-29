// SPDX-License-Identifier: MIT
/**
 * L0179 — interactive spreadsheets in the attribute-list style.
 *
 * For a program with ONE unnamed sheet the output contract is L0166's, byte for byte:
 * `{title, instructions, templateVariablesRecords, validation,
 * interaction: {type: "table", rows, columns, cells}, errors}`. Only the source surface differs —
 * attributes are words merged from a bracket list instead of an arity-2 chain. That constraint is
 * what makes tools/differential-test.mjs possible, and it still holds: the test reads 127/129.
 *
 * Beyond one sheet L0179 diverges deliberately, adding `interaction.sheets` and
 * `validation.sheets`. The envelope appears ONLY when it carries something the flat fields cannot
 * — more than one sheet, or an authored `name` — which is what keeps the equivalence above true
 * for every program that predates it. The renderer is L0179's own now (see packages/view and
 * docs/shed-l0166.md), so nothing downstream is waiting on L0166 to grow the same shape.
 *
 * Handlers for attributes are GENERATED from attributes.ts. Only containers are written by hand.
 */
import { Checker as BaseChecker, Transformer as BaseTransformer, Compiler } from "@graffiticode/l0000";
import {
  attributeFields,
  mergeAttributes,
  assertKnownAttributes,
  checkValue,
  tagValue,
} from "./attributes.js";
import { resolveInheritedPoints, getValidation } from "./validation.js";
import { MAX_LIMIT, generateDataFromArgs, buildEnv } from "./params.js";

/** Unwrap L0000's internal Record representation to plain JS. Ported from L0176. */
function toPlainObject(val: any): any {
  if (val !== null && typeof val === "object" && val._type === "record" && val._entries instanceof Map) {
    const obj: any = {};
    for (const [k, v] of val._entries) {
      const name = (k as string).replace(/^(tag|str|num):/, "");
      obj[name] = toPlainObject(v);
    }
    return obj;
  }
  if (Array.isArray(val)) return val.map(toPlainObject);
  return val;
}

// ── Checker ────────────────────────────────────────────────────────────────
//
// Deliberately thin. Value validation lives in the Transformer, because the base
// `Checker.LIST` visits only its first element — so a rule written here would fire for the first
// attribute of a list and silently skip the rest. L0166 lost a `points` guard to exactly that.

export class Checker extends BaseChecker {
  [key: string]: any;
}

/** Walk one child and return the node — the shape every generated Checker method takes. */
function checkChild(node: any, options: any, resume: any, self: any) {
  self.visit(node.elts[0], options, (e0: any) => resume(([] as any[]).concat(e0 || []), node));
}

/** Walk both children, for the arity-2 containers. */
function checkBoth(node: any, options: any, resume: any, self: any) {
  self.visit(node.elts[0], options, (e0: any) => {
    self.visit(node.elts[1], options, (e1: any) =>
      resume(([] as any[]).concat(e0 || [], e1 || []), node));
  });
}

for (const [name, meta] of Object.entries(attributeFields)) {
  // A chaining attribute is arity 2 — value plus the rest of the chain — so it has two children
  // to walk. Taking this from the same table as the lexicon keeps the two from disagreeing.
  const walk = meta.chaining ? checkBoth : checkChild;
  Checker.prototype[name] = function (node: any, options: any, resume: any) {
    walk(node, options, resume, this);
  };
}
for (const name of ["SHEETS", "SHEET", "CELLS", "CELL", "COLUMNS", "COLUMN", "ROWS", "ROW", "PARAMS"]) {
  Checker.prototype[name] = function (node: any, options: any, resume: any) {
    checkBoth(node, options, resume, this);
  };
}

// ── Transformer ────────────────────────────────────────────────────────────

export class Transformer extends BaseTransformer {
  [key: string]: any;

  /**
   * `sheets [ sheet "id" [...] ] title "..." {config}` — a member list: children plus a
   * configuration slot. That slot holds the program-level chaining attributes (`title`,
   * `instructions`, `show-sheet-tabs`, `hide-sheet-menu`, `instant-feedback`) and `params`, all of
   * which evaluate to one merged record.
   *
   * The `sheets` ARRAY is emitted only when it carries something the flat fields cannot: more
   * than one sheet, or a `name` the sheet menu needs to display. A lone unnamed sheet compiles
   * to exactly what it compiled to before multiple sheets existed — byte for byte — which is
   * what keeps `tools/differential-test.mjs` meaningful and every deployed item untouched.
   */
  SHEETS(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => {
      this.visit(node.elts[1], options, async (e1: any, v1: any) => {
        const err = ([] as any[]).concat(e0 || [], e1 || []);
        const sheets = (Array.isArray(v0) ? v0 : [v0])
          .filter((s) => s !== null && s !== undefined)
          .map((s) => toPlainObject(s));
        if (sheets.length === 0) {
          resume(err.concat("sheets: expected at least one `sheet`."), {});
          return;
        }

        const config = toPlainObject(v1) || {};
        try {
          assertKnownAttributes("SHEETS", config);
        } catch (e: any) {
          resume(err.concat(String((e && e.message) || e)), {});
          return;
        }

        // Ids are the keys a response and a validation record are filed under, so a collision is
        // a silent overwrite of one sheet's answers by another's. An unnamed sheet gets its
        // position, matching the `s1`, `s2` convention the spec already tells authors to write.
        const seen = new Set<string>();
        const resolved = sheets.map((sheet: any, i: number) => {
          const id = sheet.id || `s${i + 1}`;
          return { ...sheet, id, name: sheet.name || id };
        });
        for (const sheet of resolved) {
          if (seen.has(sheet.id)) {
            resume(
              err.concat(
                `sheets: two sheets share the id "${sheet.id}". Ids key each sheet's answers and ` +
                `grading, so a duplicate silently overwrites one sheet with the other. Give each ` +
                `sheet a distinct id.`),
              {});
            return;
          }
          seen.add(sheet.id);
        }

        // Bind the ids for PROG, which validates sheet-qualified param names against them.
        // Returned in the record rather than stashed on `options`: the options bag is shared
        // across every sheet, so a per-sheet write there is last-one-wins.
        const first = resolved[0];
        const needsEnvelope = resolved.length > 1 || sheets.some((s: any) => s.name);
        resume(err, {
          ...config,
          ...first,
          ...(needsEnvelope ? { sheets: resolved } : {}),
          sheetIds: resolved.map((s: any) => s.id),
        });
      });
    });
  }

  /** `sheet "id" [...]` — a keyed entry: the id, and the sheet's attribute list. */
  SHEET(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => {
      this.visit(node.elts[1], options, async (e1: any, v1: any) => {
        const err = ([] as any[]).concat(e0 || [], e1 || []);
        try {
          const attrs = mergeAttributes(toPlainObject(v1), "sheet");
          assertKnownAttributes("SHEET", attrs);
          // A sheet without cells compiles to an empty grid and renders nothing — the styling
          // and column widths have nothing to apply to. Caught here rather than left to the
          // reader: it is silent otherwise, and a generator asked for "a header row with bold
          // white text" wrote exactly this, styling row 1 with no cells in it. Every one of
          // L0166's 129 corpus programs carries a `cells` block, so nothing legitimate is lost.
          if (!attrs.cells || Object.keys(attrs.cells).length === 0) {
            resume(
              err.concat(
                "sheet: no cells. A sheet needs a `cells` block holding at least one cell, " +
                "e.g. cells [ cell A1 [text \"Total\"] ] {} — styling a row or column has no " +
                "effect on its own.",
              ),
              {});
            return;
          }
          // The id travels IN the record, not on `options`. It used to be stashed as
          // `options["sheet-id"]`, which no one ever read — and which could not have worked once
          // there was more than one sheet, since every sheet writes the same shared bag and the
          // last one wins. SHEETS reads it from here; PROG destructures a fixed key set and never
          // spreads, so neither `id` nor `name` can leak into a single-sheet program's output.
          const id = tagValue(toPlainObject(v0));
          resume(err, { ...attrs, ...(id ? { id } : {}) });
        } catch (e: any) {
          resume(err.concat(String((e && e.message) || e)), {});
        }
      });
    });
  }

  PARAMS(node: any, options: any, resume: any) {
    // Ported from L0166. Note it does NOT visit its continuation: `params {...} {v: "0.0.1"}`
    // discards the trailing record, which is why no `v` reaches the output.
    this.visit(node.elts[0], options, (err1: any, val1: any) => {
      if (err1 && err1.length) {
        resume(err1, {});
        return;
      }
      let values: any[] = [];
      let params = options.data && options.data.params
        ? toPlainObject(options.data.params)   // Use form data.
        : toPlainObject(val1);                 // Use defaults.
      if (params) {
        let keys: any;
        let vals: any;
        if (Array.isArray(params)) {
          keys = params[0];
          vals = params.slice(1);
        } else {
          keys = Object.keys(params);
          vals = [Object.values(params)];
          params = [keys].concat(vals);  // Make new form for params.
        }
        keys.forEach((k: string, i: number) => {
          keys[i] = k.trim();
        });
        values.push(keys);
        vals.forEach((v: any) => {
          values = values.concat(generateDataFromArgs(keys, v));
        });
      }
      options.params = params;
      let limit = (options.data && options.data.limit) || (val1 && val1.limit) || MAX_LIMIT;
      limit = (limit < values.length && limit) || values.length;
      limit = (limit < MAX_LIMIT && limit) || MAX_LIMIT;
      if (values.length > limit) {
        console.log(`WARNING truncating seed list to ${limit} values.`);
        values = values.slice(0, limit + 1); // Plus 1 because column names.
      }
      const records = values.slice(1).map((v: any) => buildEnv(values[0], v));
      resume([], { templateVariablesRecords: records });
    });
  }
}

/**
 * Generated attribute methods: read the argument per the table, return a single-key record.
 * Whatever encloses it — a keyed entry, or an object-shaped attribute — merges the list.
 */
for (const [name, meta] of Object.entries(attributeFields)) {
  Transformer.prototype[name] = function (node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => {
      const err = ([] as any[]).concat(e0 || []);
      let value: any;
      try {
        const raw = toPlainObject(v0);
        // Type check here rather than in the Checker: the base Checker.LIST visits only its
        // first element, so a rule there would skip every attribute after the first.
        const typeError = checkValue(name, meta, raw);
        if (typeError) {
          resume(err.concat(typeError), {});
          return;
        }
        value = meta.shape === "object"
          ? (() => {
              const attrs = mergeAttributes(raw, meta.field);
              assertKnownAttributes(name, attrs);
              return attrs;
            })()
          : meta.coerce
            ? meta.coerce(raw)
            : raw;
      } catch (e: any) {
        resume(err.concat(String((e && e.message) || e)), {});
        return;
      }
      if (!meta.chaining) {
        resume(err, { [meta.field]: value });
        return;
      }
      // Arity 2: merge the rest of the chain, so `title "a" instructions "b" {}` yields both.
      // Note this MERGES its continuation where PARAMS discards its own — a transcribed L0166
      // quirk that is why anything written after `params` is dropped, and why `params` goes last.
      this.visit(node.elts[1], options, async (e1: any, v1: any) => {
        resume(err.concat(e1 || []), { [meta.field]: value, ...(toPlainObject(v1) || {}) });
      });
    });
  };
}

/**
 * Keyed entries — `cell A1 [...]`, `column A [...]`, `row 1 [...]`.
 *
 * Emits `{ [key]: attributes }`, exactly L0166's CELL/COLUMN/ROW, so the enclosing member list
 * folds them into the same `cells` / `columns` / `rows` records.
 */
// Key coercion is per container, transcribed from L0166: CELL and COLUMN read a tag (`A1`, `A`),
// while ROW accepts a string region (`"*"`, `"1..5"`) OR a bare number (`row 1`), stringifying it.
// A single shared rule would reject `row 1`, which the corpus uses.
const keyOf: Record<string, (v: any) => string | undefined> = {
  CELL: (v) => tagValue(v),
  COLUMN: (v) => tagValue(v),
  ROW: (v) => (typeof v === "string" && v) || (typeof v === "number" && String(v)) || tagValue(v),
};

for (const [name, container] of [["CELL", "cell"], ["COLUMN", "column"], ["ROW", "row"]] as const) {
  Transformer.prototype[name] = function (node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => {
      this.visit(node.elts[1], options, async (e1: any, v1: any) => {
        const err = ([] as any[]).concat(e0 || [], e1 || []);
        try {
          const key = keyOf[name](toPlainObject(v0));
          if (!key) {
            resume(err.concat(`${container}: expected a name, e.g. ${container} A1 [text "x"].`), {});
            return;
          }
          const attrs = mergeAttributes(toPlainObject(v1), `${container} ${key}`);
          assertKnownAttributes(name, attrs);
          resume(err, { [key]: attrs });
        } catch (e: any) {
          resume(err.concat(String((e && e.message) || e)), {});
        }
      });
    });
  };
}

/**
 * Member lists — `cells [...] {config}`, `columns [...] {config}`, `rows [...] {config}`.
 *
 * Merges the keyed entries into one record under `field`, then spreads the configuration record,
 * matching L0166's CELLS/COLUMNS/ROWS.
 */
for (const [name, field] of [["CELLS", "cells"], ["COLUMNS", "columns"], ["ROWS", "rows"]] as const) {
  Transformer.prototype[name] = function (node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => {
      this.visit(node.elts[1], options, async (e1: any, v1: any) => {
        const err = ([] as any[]).concat(e0 || [], e1 || []);
        const entries = toPlainObject(v0);
        const merged = (Array.isArray(entries) ? entries : [entries]).reduce(
          (acc: any, entry: any) => ({ ...acc, ...entry }), {});
        resume(err, { ...toPlainObject(v1), [field]: merged });
      });
    });
  };
}

/**
 * PROG — the output contract, transcribed from L0166 so the two languages agree field for field.
 */
Transformer.prototype.PROG = function (node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, async (e0: any, v0: any) => {
    const rawData = options?.data || {};
    // Strip an upstream `errors` field before merging — it is not spreadsheet state and would
    // otherwise make this stage look errored whenever its input was.
    const { errors: _upstreamErrors, ...data } = rawData;
    const err = ([] as any[]).concat(e0 || []);
    let val0 = Array.isArray(v0) ? v0[v0.length - 1] : v0;   // Last expression.
    val0 = toPlainObject(val0) || {};

    // Points inheritance and validation are resolved PER SHEET. Both do global lookups —
    // `resolveInheritedPoints` reads `columns[key[0]]` and `rows[region]`, and `getValidation`
    // writes `regions[region].rows[rowIndex][col]` — so run once over a merged grid, sheet 2's
    // `A1` would inherit sheet 1's column-A points and then overwrite its validation entry. Both
    // failures are silent, and both produce a maximum score no correct response can reach, which
    // is exactly what validation.ts's header warns about.
    const sheetList: any[] = Array.isArray(val0.sheets) ? val0.sheets : [val0];
    const resolvedSheets = sheetList.map((s: any) => resolveInheritedPoints(s || {}));
    const perSheetValidation = resolvedSheets.map((s: any) => getValidation(s));

    // The flat fields stay sheet 1's, so an older renderer or scorer shows and scores the first
    // sheet instead of failing. `val0` itself is re-resolved for its own flat cells.
    val0 = resolveInheritedPoints(val0);
    const {
      templateVariablesRecords,
      title,
      instructions,
      columns,
      rows,
      cells,
      hideMenu,
      showSheetTabs,
      hideSheetMenu,
      feedback,
      sheetIds,
      errors,
    } = val0;
    const multi = Array.isArray(val0.sheets) && val0.sheets.length > 1;

    // With several sheets, hiding the menu AND turning tabs off leaves nothing to navigate with:
    // sheets 2..N compile fine and can never be opened. Refused rather than shipped, for the same
    // reason validAttributes exists — a program that compiles clean and silently does not do what
    // it says is the failure this language is built to prevent.
    if (multi && hideSheetMenu === true && showSheetTabs === false) {
      err.push(
        "sheets: `hide-sheet-menu true` with `show-sheet-tabs false` leaves no way to reach sheets " +
        "beyond the first — there is no tab strip and no sheet menu. Drop one of the two.");
    }

    // A sheet-qualified param name (`"s2!A1"`) must name a sheet that exists. `buildEnv` treats
    // keys as opaque strings, so an unchecked typo becomes a param nothing ever reads.
    for (const record of (templateVariablesRecords || [])) {
      for (const key of Object.keys(record || {})) {
        const bang = key.indexOf("!");
        if (bang < 0) continue;                       // bare name: sheet 1, as it has always been
        const [sheetId, address] = [key.slice(0, bang), key.slice(bang + 1)];
        if (sheetIds && !sheetIds.includes(sheetId)) {
          err.push(
            `params: "${key}" names the sheet "${sheetId}", which this program does not have. ` +
            `Its sheets are: ${sheetIds.join(", ")}.`);
        } else if (!/^[A-Z]+[0-9]+$/.test(address)) {
          err.push(
            `params: "${key}" is not a cell address. A qualified param name is a sheet id, "!", ` +
            `and an address, e.g. "s2!A1".`);
        }
      }
    }

    const totalPoints = perSheetValidation.reduce((n: number, v: any) => n + (v?.points || 0), 0);
    const val = {
      title: title || "",
      instructions: instructions || "",
      // Only when written, so a program without `instant-feedback` compiles byte-identically.
      ...(feedback !== undefined ? { feedback } : {}),
      templateVariablesRecords,
      validation: {
        ...getValidation(val0),
        ...(multi ? {
          points: totalPoints,
          sheets: Object.fromEntries(
            val0.sheets.map((s: any, i: number) => [s.id, perSheetValidation[i]]),
          ),
        } : {}),
      },
      interaction: {
        type: "table",
        rows,
        columns,
        cells,
        ...(hideMenu !== undefined ? { hideMenu } : {}),
        ...(showSheetTabs !== undefined ? { showSheetTabs } : {}),
        ...(hideSheetMenu !== undefined ? { hideSheetMenu } : {}),
        ...(Array.isArray(val0.sheets) ? {
          sheets: val0.sheets.map((s: any, i: number) => ({
            id: s.id,
            name: s.name,
            rows: resolvedSheets[i].rows,
            columns: resolvedSheets[i].columns,
            cells: resolvedSheets[i].cells,
            ...(s.hideMenu !== undefined ? { hideMenu: s.hideMenu } : {}),
          })),
        } : {}),
      },
      errors,
    };
    resume(err, { ...val, ...data });
  });
};

export const compiler = new Compiler({
  langID: "0179",
  version: "v0.0.1",
  Checker,
  Transformer,
});
