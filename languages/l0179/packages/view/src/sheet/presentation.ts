// SPDX-License-Identifier: MIT
/**
 * Presentation POLICY — what colour a cell should be, and how two border specifications combine.
 *
 * Lifted out of TableEditor.tsx unchanged. This is the half of the styling system that is a
 * decision rather than a mechanism: the mechanism (ProseMirror node decorations carrying inline
 * style strings) stays in the renderer, but *which* colour and *which* border belong here, because
 * they are the same under any renderer.
 */

/** The `assess` feedback palette. Green for a correct cell, red for an incorrect one. */
export const ASSESS_VALID = "#efe";
export const ASSESS_INVALID = "#fee";

/**
 * A cell's background, or null to leave it alone.
 *
 * Three rules, in order:
 *   - headers are never coloured (row or column 1 — the label row and label column);
 *   - a cell carrying a `score` shows assess feedback, EXCEPT the one the caret is in, so a learner
 *     is not told they are wrong while still typing the answer;
 *   - otherwise its authored background, if any.
 */
export const getCellColor = (cell: any): string | null => {
  const {
    row, col, name, background,
    "background-color": bgColorKebab, backgroundColor: bgColorCamel,
    lastFocusedCell, score,
  } = cell;
  const backgroundColor = bgColorKebab || bgColorCamel; // Support both kebab-case and camelCase

  // Don't apply colors to header cells (row 1 or column 1)
  if (row <= 1 || col <= 1) {
    return null;
  }

  return (score !== undefined && name !== lastFocusedCell && (
    (score.isValid === true && ASSESS_VALID) ||
      ASSESS_INVALID
  )) || backgroundColor || background || null;
};

/**
 * Combine two border specifications, and note that the two authored forms combine DIFFERENTLY:
 *
 *   - a CSS string (`"1px solid black"`) OVERRIDES — the more specific source wins outright;
 *   - a side list (`"top"`, `"top,left"`, `"all"`) UNIONS — a row's top and a column's left both
 *     apply to the cell where they meet.
 *
 * That asymmetry is the documented contract, not an accident: a CSS border describes the whole box,
 * so merging two of them would produce something neither author asked for, whereas side lists name
 * individual edges and compose naturally.
 */
export const mergeBorders = (border1: any, border2: any): any => {
  if (!border1) return border2;
  if (!border2) return border1;

  // If either is a CSS border string (e.g., "1px solid black"), use the most specific one
  if (border1.includes("px") || border2.includes("px")) {
    // Cell borders take precedence over column/row borders for CSS styles
    return border2;
  }

  // Parse side specifications
  const parseSides = (border: string) => {
    if (border === "all") return ["top", "bottom", "left", "right"];
    return border.split(",").map((s) => s.trim().toLowerCase());
  };

  const sides1 = parseSides(border1);
  const sides2 = parseSides(border2);

  // Merge unique sides
  const mergedSides = [...new Set([...sides1, ...sides2])];

  // If all sides are present, return 'all'
  if (mergedSides.includes("top") && mergedSides.includes("bottom") &&
      mergedSides.includes("left") && mergedSides.includes("right")) {
    return "all";
  }

  return mergedSides.join(",");
};
