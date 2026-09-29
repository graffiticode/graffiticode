// SPDX-License-Identifier: MIT
/**
 * Parameter expansion, ported VERBATIM from L0166 (packages/api/src/compiler.js, PARAMS and its
 * nested helpers). L0179 must emit byte-identical `templateVariablesRecords`, so this is a
 * transcription, not a rewrite — the differential test in tools/differential-test.ts pins it.
 *
 * The one structural change: L0166 declares these as functions nested inside the PARAMS method.
 * Here they are module scope so the transformer stays readable.
 */
import { Decimal } from "decimal.js";
import { assert } from "@graffiticode/l0000";

export const MAX_LIMIT = 249;

export function expandArgs(args) {
  const table = [];
  args = args || [];
  args.forEach((s) => {
    const exprs = s.split(',');
    const vals = [];
    exprs.forEach(expr => {
      const [r, _incr = 1] = expr.split(':');
      const [start, _stop] = r.split('..');
      let incr = _incr;
      let stop = _stop;
      if (+start >= +stop) {
        // Guard against nonsense.
        stop = undefined;
      }
      if (stop === undefined) {
        vals.push(start.trim());
      } else {
        let e; let n; let
t;
        if (!Number.isNaN(parseFloat(start))) {
          t = 'F';
          n = parseFloat(start);
          e = parseFloat(stop);
        } else {
          t = 'V';
          n = start.charCodeAt(0);
          e = stop.charCodeAt(0);
        }
        incr = Number.isNaN(+incr) ? 1 : +incr;
        let i = new Decimal(0);
        for (; i.cmp(new Decimal(e).sub(n)) <= 0; i = i.add(incr)) {
          // Expand range
          switch (t) {
          case 'F':
            vals.push(String(new Decimal(n).add(i)));
            break;
          case 'V':
            vals.push(String.fromCharCode(n + i) + start.substring(1));
            break;
          default:
            break;
          }
        }
      }
    });
    table.push(vals);
  });
  return table;
}

export function buildEnv(keys, vals) {
  const env = {}; // Object.assign({}, params);
  keys.forEach((k, i) => {
    if (vals[i] !== undefined) {
      // env[k] = {
      //   type: 'const',
      //   value: vals[i],
      // };
      env[k] = vals[i];
    }
  });
  return env;
}

export function evalExpr(env, expr, resume) {
  if (expr.indexOf('=') === 0) {
    assert(false, "not yet implemented");
  } else {
    resume([], expr);
  }
}

export function generateDataFromArgs(keys, args) {
  const table = expandArgs(args);
  let data = [];
  let count = 0;
  for (let i = 0; i < table.length; i++) {
    // Expand the current set with each parameter (i).
    let row;
    const len = data.length; // Current number of unexpanded rows.
    const newData = [];
    for (let j = 0; j < table[i].length; j++) {
      // For each value (j) of each parameter (i).
      const val = table[i][j];
      if (len === 0) {
        // First time through so just push the value as a column.
        newData.push([val]);
      } else {
        for (let k = 0; k < len && (count < MAX_LIMIT + len || j < 1); k++) {
          // Add a new row which is the old row (k) extended by the current column value (i, j).
          const env = buildEnv(keys, data[k]);
          evalExpr(env, val, (err, val) => {
            row = [].concat(data[k]).concat(val);
            newData.push(row);
          });
          count++;
        }
      }
    }
    data = newData;
  }
  return data;
}
