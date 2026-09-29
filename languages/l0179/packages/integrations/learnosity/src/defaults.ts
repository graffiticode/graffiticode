// SPDX-License-Identifier: MIT
/**
 * Fallback envelope for a question carrying no authored data, or data that will not parse.
 *
 * L0179 compiles to the same `{validation, interaction: {type: "table", rows, columns, cells}}`
 * shape as L0166 — asserted field for field by packages/core/tools/differential-test.mjs — so
 * this is L0166's fallback verbatim.
 */
export const defaultData = {
  validation: { points: 0, regions: {}, cells: {} },
  interaction: { type: "table", v: "0.0.1", cells: {}, columns: {} },
};
