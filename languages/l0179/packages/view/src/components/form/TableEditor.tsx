// SPDX-License-Identifier: MIT
/*
  TODO
  [ ] Handle single and double click and tab in cells
  [x] Sort dependency tree & check for cycles
  [ ] Make expanderBuilders a module parameter
  [ ] BUG fix updating cells when clicking on headers
*/

import React, { useState, useEffect, useRef } from 'react'; React;

// Only the two stylesheets that describe something on screen: the editor surface and the table.
// prosemirror-menu, -example-setup and -gapcursor were imported for their CSS alone — there is no
// ProseMirror menu, no example setup and no gap cursor here — and were the only reason those three
// packages were dependencies at all.
import 'prosemirror-view/style/prosemirror.css';
import "prosemirror-tables/style/tables.css";

import { EditorView } from 'prosemirror-view';
import {
  EditorState,
  TextSelection,
} from 'prosemirror-state';
import { Schema } from 'prosemirror-model';
import { schema as baseSchema } from 'prosemirror-schema-basic';
import { keymap } from 'prosemirror-keymap';

import {
//   addColumnAfter,
//   addColumnBefore,
//   deleteColumn,
//   addRowAfter,
//   addRowBefore,
//   deleteRow,
//   mergeCells,
//   splitCell,
//   setCellAttr,
//   toggleHeaderRow,
//   toggleHeaderColumn,
//   toggleHeaderCell,
//   goToNextCell,
//   deleteTable,
//   findCell,
  TableMap,
} from "prosemirror-tables";
import {
  columnResizing,
  tableEditing,
  tableNodes,
  fixTables,
//  CellSelection,
} from "prosemirror-tables";

import { baseKeymap } from "prosemirror-commands"
import { undo, redo, history } from "prosemirror-history";
import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from "prosemirror-view";
import ReactDOM from 'react-dom/client';
import { MenuView } from './MenuView';
import { ProtectedCellTooltip } from './ProtectedCellTooltip';
//import { debounce } from "lodash";

// Scoring lives in ../../scoring, which is DOM-free so the Learnosity scorer bundle can load it
// server-side. It was lifted OUT of this file rather than copied alongside it: two implementations
// of "is this answer right" is exactly the drift that would mark a learner wrong in the grid and
// right in the scorer. `scoreCells` runs here on every transaction, to paint assess feedback live.
import { scoreCells } from '../../scoring/index.js';

// The spreadsheet engine — evaluation, dependencies, cycles, formatting. It used to live in THIS
// file, interleaved with the ProseMirror plumbing while importing none of it; see
// ../../sheet/index.ts. That this file no longer imports TransLaTeX or any value normalization at
// all is the measure of how cleanly the two separated. What is left here is the renderer.
import {
  evalCell,
  formatCellValue,
  fixText,
  buildGraph,
  setFormula,
  recalculate,
  createSheetCache,
  getResponses,
  getChangedCells,
  getCellColor,
  mergeBorders,
  defaultAlign,
  numericColumnHeaders,
  getCellRange,
  getColumnRange,
  getRowRange,
  spansOf,
  gridExtent,
  columnIndex,
} from '../../sheet/index.js';

const buildMenuPlugin = (formState) => {
  let currentHideMenu = formState.data.interaction?.hideMenu || false;
  return new Plugin({
    view(editorView) {
      const menuDiv = document.createElement('div');
      const root = ReactDOM.createRoot(menuDiv!);
      editorView.dom.parentNode.insertBefore(menuDiv, editorView.dom);
      const update = () => {
        const hideMenu = formState.data.interaction?.hideMenu || false;
        root.render(
          <MenuView
            className=""
            editorView={editorView}
            hideMenu={hideMenu}
          />,
        );
      };
      update();
      return {
        update() {
          // Check if hideMenu value has changed
          const hideMenu = formState.data.interaction?.hideMenu || false;
          if (hideMenu !== currentHideMenu) {
            currentHideMenu = hideMenu;
            root.render(
              <MenuView
                className=""
                editorView={editorView}
                hideMenu={hideMenu}
              />,
            );
          }
        },
        destroy() {
          root.unmount();
        }
      };
    }
  });
};

const applyDecoration = ({ doc, cells }) => {
  const decorations = [];
  cells.forEach(({ from, to, color, textColor, fontWeight, border, borderClass, sticky, link }) => {
    decorations.push(Decoration.node(from, to, {
      // `sticky` before `border`: a focused cell's border style raises its z-index above the
      // frozen cells', and has to win.
      style: `
        background-color: ${color};
        ${textColor ? `color: ${textColor};` : ''}
        ${fontWeight ? `font-weight: ${fontWeight};` : ''}
        ${sticky || ''}
        ${border};
      `,
      class: borderClass || ""
    }));
    // A link cell's label, wrapped in an anchor. Inline, over the paragraph's text: the cell's
    // content stays plain text, so the engine and the formula bar see what they always saw.
    // Rechecked here as well as in the compiler — this becomes an href a learner clicks.
    if (isWebAddress(link) && to - 2 > from + 2) {
      decorations.push(Decoration.inline(from + 2, to - 2, {
        nodeName: "a",
        href: link,
        target: "_blank",
        rel: "noopener noreferrer",
        class: "gc-link",
      }));
    }
  });
  return DecorationSet.create(doc, decorations);
};

/** The only links the grid will render or open: http(s), as the compiler allows. */
export const isWebAddress = (v: any): boolean => typeof v === "string" && /^https?:\/\/[^\s]+$/i.test(v);

/**
 * The sticky style for a cell in the frozen rows or columns, or "". Offsets come from CSS
 * variables the freeze plugin measures and sets on the editor's container (`--gc-top-N`,
 * `--gc-left-N`), because positions are layout, and decorations are computed without the DOM.
 * The headings freeze with the area they label. A span never crosses the frozen edge (the compiler
 * refuses that), so a cell is wholly inside or wholly outside.
 */
export const stickyStyle = (rect, freezeRows, freezeColumns) => {
  if (!rect) return "";
  const inRows = freezeRows > 0 && rect.bottom <= freezeRows + 1;
  const inColumns = freezeColumns > 0 && rect.right <= freezeColumns + 1;
  if (!inRows && !inColumns) return "";
  return "position: sticky; " +
    (inRows ? `top: var(--gc-top-${rect.top}, 0px); ` : "") +
    (inColumns ? `left: var(--gc-left-${rect.left}, 0px); ` : "") +
    `z-index: ${inRows && inColumns ? 4 : inRows ? 3 : 2};`;
};

// Determine if a position is within a header cell
const isPosInHeader = (state, pos) => {
  if (pos === null) return false;
  const $pos = state.doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === "table_header") {
      return true;
    }
  }
  return false;
};

/**
 * The cell holding the selection's anchor: its table, map, and rectangle in map coordinates (the
 * heading row is row 0 and the heading column is column 0). Read off the anchor's ancestors, not
 * by scanning `TableMap.map` for an offset — with merged cells the map repeats an anchor's offset
 * at every position it covers, so the map is not ordered and a scan lands on the wrong cell.
 */
export const cellRectAt = (state, pos = state.selection.$anchor.pos) => {
  const $pos = state.doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    if (!isTableCellOrHeader($pos.node(depth))) continue;
    const table = findTable($pos);
    if (!table) return null;
    const map = TableMap.get(table.node);
    const offset = $pos.before(depth) - table.pos - 1;
    return { table, map, offset, rect: map.findCell(offset) };
  }
  return null;
};

/**
 * The data cells in reading order: row by row, left to right, each cell ONCE, at its top-left. A
 * merged cell occupies several map positions, and stepping position by position would land on it
 * again and again — Shift-Tab inside an A1:B1 merge used to stay where it was.
 */
const dataCellsInOrder = map => {
  const cells = [];
  for (let r = 1; r < map.height; r++) {
    for (let c = 1; c < map.width; c++) {
      const offset = map.map[r * map.width + c];
      const rect = map.findCell(offset);
      if (rect.left === c && rect.top === r) cells.push(offset);
    }
  }
  return cells;
};

// The next data cell in reading order (dir 1) or the previous (dir -1), wrapping at either end.
export const findNextDataCell = (state, dir) => {
  const at = cellRectAt(state);
  if (!at) return null;
  const { table, map, offset } = at;
  const order = dataCellsInOrder(map);
  if (order.length === 0) return null;
  const i = order.indexOf(offset);
  // From a heading (not in the order) forward is the first data cell, backward the last.
  const next = i < 0
    ? (dir > 0 ? order[0] : order[order.length - 1])
    : order[(i + dir + order.length) % order.length];
  return next + table.pos + 1;
};

// Skip headers in navigation
const skipHeadersGoToNextCell = dir => (state, dispatch) => {
  // Find the next non-header cell position
  const nextPos = findNextDataCell(state, dir);

  if (nextPos !== null && dispatch) {
    // Create a text selection at the next position
    const tr = state.tr;
    const doc = tr.doc;
    const $nextPos = doc.resolve(nextPos);
    const selection = TextSelection.near($nextPos);

    // Update the selection and dispatch the transaction
    dispatch(tr.setSelection(selection));

    return true;
  }

  return false;
};


/**
 * Which assess feedback is showing: `"checked"` after a check (the host's Check button, or
 * Learnosity's Check Answer, both of which set `showValidationUI`), `"instant"` all the time when
 * the program asked for `instant-feedback true`, and `false` otherwise — the grid gives nothing
 * away while the learner works. Instant feedback judges only what the learner has entered; a
 * check also marks the empty assessed cells wrong. L0183 draws the same line.
 */
export const showsFeedback = (data: any): "checked" | "instant" | false =>
  data?.showValidationUI === true ? "checked" : data?.feedback === "instant" ? "instant" : false;

const isAnswered = (cell: any): boolean => String(cell?.text ?? "").trim() !== "";

const applyModelRules = (cellExprs, state, value, validation, formState) => {
  const cells = getCells(cellExprs, state);
  const interactionCells = formState?.data?.interaction?.cells;
  // Not scored at all while feedback is hidden, so no cell can pick up a colour from it.
  let scoredCells = value.showFeedback
    ? scoreCells({ cells: value.cells, validation, interactionCells })
    : {};
  if (value.showFeedback === "instant") {
    scoredCells = Object.fromEntries(
      Object.entries(scoredCells).filter(([name]) => isAnswered(value.cells[name])),
    );
  }
  const { doc, selection } = state;
  const { lastFocusedCell } = value;
  const focus = formState?.data?.focus;

  // Multiply first row and first column values and compare to body values.
  const cellColors = [];
  const cellTextColors = [];
  const cellFontWeights = [];
  cells.forEach(cell => {
    let color = getCellColor({
      ...cell,
      lastFocusedCell,
      score: scoredCells[cell.name]?.score,
    });
    let textColor = null;
    let fontWeight = null;

    // Set default text color and font weight for headers
    if (cell.row === 1 || cell.col === 1) {
      textColor = "#5f6368"; // Default Google Sheets gray for headers
      fontWeight = "400"; // Normal weight for headers
    }

    // Apply highlighting based on focus type
    if (focus) {
      // Check if this is a header and apply dark blue when selected
      if (cell.row === 1 && cell.col > 1) {
        // Column header (A0, B0, C0, etc.)
        const cellColumn = cell.name.match(/^([A-Z]+)/)?.[1];
        const selectedColumns = focus?.columns || (focus?.name ? [focus?.name] : []);
        if (focus?.type === "column" && (cellColumn === focus?.name || selectedColumns.includes(cellColumn))) {
          color = "#1a73e8"; // Google Sheets selected header blue
          textColor = "#ffffff"; // White text for selected header
          fontWeight = "600"; // Semibold weight when selected
        } else if (focus.type === "sheet") {
          color = "#1a73e8"; // Google Sheets selected header blue for all column headers
          textColor = "#ffffff"; // White text for selected header
          fontWeight = "600"; // Semibold weight when selected
        } else {
          // Unselected column header
          textColor = "#5f6368"; // Google Sheets gray text for unselected headers
          fontWeight = "400"; // Normal weight for unselected headers
        }
      } else if (cell.row > 1 && cell.col === 1) {
        // Row header (_1, _2, _3, etc.)
        const cellRow = cell.name.match(/(\d+)$/)?.[1];
        const selectedRows = focus?.rows || (focus?.name ? [focus?.name] : []);
        if (focus.type === "row" && (cellRow === focus.name || selectedRows.includes(cellRow))) {
          color = "#1a73e8"; // Google Sheets selected header blue
          textColor = "#ffffff"; // White text for selected header
          fontWeight = "600"; // Semibold weight when selected
        } else if (focus.type === "sheet") {
          color = "#1a73e8"; // Google Sheets selected header blue for all row headers
          textColor = "#ffffff"; // White text for selected header
          fontWeight = "600"; // Semibold weight when selected
        } else {
          // Unselected row header
          textColor = "#5f6368"; // Google Sheets gray text for unselected headers
          fontWeight = "400"; // Normal weight for unselected headers
        }
      } else if (cell.row === 1 && cell.col === 1) {
        // Top-left corner header (_0)
        if (focus.type === "sheet") {
          color = "#1a73e8"; // Google Sheets selected header blue
          textColor = "#ffffff"; // White text for selected header
          fontWeight = "600"; // Semibold weight when selected
        } else {
          // Unselected top-left corner
          textColor = "#5f6368"; // Google Sheets gray text for unselected headers
          fontWeight = "400"; // Normal weight for unselected headers
        }
      }
      // For data cells, apply light blue highlight
      else if (cell.row > 0 && cell.col > 0) {
        // Check if this cell currently has the selection/cursor
        const isCellSelected = selection.anchor > cell.from && selection.anchor < cell.to;

        if (!isCellSelected) {
          // Only apply highlighting if this cell does NOT have the cursor
          if (focus.type === "sheet") {
            // Highlight all data cells for sheet focus
            color = "#e6f3ff"; // Light blue for entire sheet
          } else if (focus.type === "column") {
            // Check if this cell is in any of the focused columns
            const cellColumn = cell.name.match(/^([A-Z]+)/)?.[1];
            const selectedColumns = focus?.columns || (focus?.name ? [focus?.name] : []);
            if (cellColumn === focus?.name || selectedColumns.includes(cellColumn)) {
              color = "#e6f3ff"; // Light blue for focused column
            }
          } else if (focus.type === "row") {
            // Check if this cell is in any of the focused rows
            const cellRow = cell.name.match(/(\d+)$/)?.[1];
            const selectedRows = focus?.rows || (focus?.name ? [focus?.name] : []);
            if (cellRow === focus.name || selectedRows.includes(cellRow)) {
              color = "#e6f3ff"; // Light blue for focused rows
            }
          } else if (focus.type === "cell") {
            // Check if this cell is in the selection (either range or multiple individual cells)
            // First check if we have a cells array
            if (focus.cells && focus.cells.includes(cell.name)) {
              color = "#e6f3ff"; // Light blue for selected cells
            } else if (focus.name && focus.name.includes(',')) {
              // For comma-separated list of cells
              const selectedCells = focus.name.split(',').map(c => c.trim());
              if (selectedCells.includes(cell.name)) {
                color = "#e6f3ff"; // Light blue for selected cells
              }
            } else if (focus.name === cell.name) {
              // Single cell selection
              color = "#e6f3ff"; // Light blue for selected cell
            }
          }
        }
        // When focus.type === "cell" or this cell has the cursor, no highlighting is applied (stays white)
      }
    }

    const { row, col } = cell;
    if (cellColors[row] === undefined) {
      cellColors[row] = [];
    }
    cellColors[row][col] = color;

    if (cellTextColors[row] === undefined) {
      cellTextColors[row] = [];
    }
    cellTextColors[row][col] = textColor;

    if (cellFontWeights[row] === undefined) {
      cellFontWeights[row] = [];
    }
    cellFontWeights[row][col] = fontWeight;
  });
  // The engine's type (`value.cells`) exists from the first build, unlike the plugin state
  // `getCells` reads, so it decides what is a number.
  const typeOf = (cell) => value.cells?.[cell.name]?.type || cell.type;
  const numericHeaders = numericColumnHeaders(cells, typeOf);
  const getBorderStyle = (cell, isFocused) => {
    // Check if cell has a border property (CSS string or comma-separated sides)
    let hasBorderProperty = false;
    let borderPropertyStyle = '';

    if (cell.border && typeof cell.border === 'string') {
      hasBorderProperty = true;
      // Check if it's a CSS border string
      if (cell.border.includes('px') || cell.border.includes('solid') ||
          cell.border.includes('dashed') || cell.border.includes('dotted') ||
          cell.border.includes('#') || cell.border.includes('rgb') ||
          cell.border.includes('blue') || cell.border.includes('red') ||
          cell.border.includes('green') || cell.border.includes('black') ||
          cell.border.includes('gray') || cell.border.includes('grey')) {
        // Extract width and color for box-shadow
        const borderMatch = cell.border.match(/(\d+(?:\.\d+)?px)\s+\w+\s+(.+)/);
        if (borderMatch) {
          const [, width, color] = borderMatch;
          borderPropertyStyle = `box-shadow: inset 0 0 0 ${width} ${color}; `;
        } else {
          borderPropertyStyle = 'box-shadow: inset 0 0 0 2px #666; ';
        }
      } else {
        // Handle side specifications (e.g., "bottom", "top,left", "all")
        const sides = cell.border.split(',').map(s => s.trim().toLowerCase());
        const shadows = [];

        if (sides.includes('all')) {
          borderPropertyStyle = 'box-shadow: inset 0 0 0 2px #666; ';
        } else {
          // Create individual shadows for each side
          if (sides.includes('top')) {
            shadows.push('inset 0 2px 0 0 #666');
          }
          if (sides.includes('bottom')) {
            shadows.push('inset 0 -2px 0 0 #666');
          }
          if (sides.includes('left')) {
            shadows.push('inset 2px 0 0 0 #666');
          }
          if (sides.includes('right')) {
            shadows.push('inset -2px 0 0 0 #666');
          }

          if (shadows.length > 0) {
            borderPropertyStyle = `box-shadow: ${shadows.join(', ')}; `;
          }
        }
      }
    }

    // Generate CSS class for custom borders (legacy, not used with box-shadow)
    const borderClass = '';

    // Define default borders for different cell types
    const defaultBorders = {
      top: '1px solid #e0e0e0',    // Google Sheets light gray for all grid lines
      right: '1px solid #e0e0e0',
      bottom: '1px solid #e0e0e0',
      left: '1px solid #e0e0e0'
    };
    // Adjust defaults based on cell position and state
    if (cell.col === 1 && cell.row === 1) {
      defaultBorders.right = '1px solid #e0e0e0';  // Same color for all grid lines
      defaultBorders.bottom = cell.underline ? '2px solid #333' : '1px solid #e0e0e0';
    } else if (cell.col === 1) {
      defaultBorders.right = '1px solid #e0e0e0';
      defaultBorders.bottom = cell.underline ? '2px solid #333' : '1px solid #e0e0e0';
    } else if (cell.row === 1) {
      defaultBorders.bottom = cell.underline ? '2px solid #333' : '1px solid #e0e0e0';
    } else {
      defaultBorders.bottom = cell.underline ? '2px solid #333' : '1px solid #e0e0e0';
    }
    let styleStr = '';
    // Always apply default borders for the grid
    styleStr += `border-top: ${defaultBorders.top}; `;
    styleStr += `border-right: ${defaultBorders.right}; `;
    styleStr += `border-bottom: ${defaultBorders.bottom}; `;
    styleStr += `border-left: ${defaultBorders.left}; `;

    // Apply box-shadow for border property or focus
    if (isFocused) {
      // Focus takes precedence with !important
      styleStr += 'box-shadow: inset 0 0 0 2px #1a73e8 !important; z-index: 10; ';
    } else if (hasBorderProperty) {
      // Apply border property when not focused
      styleStr += borderPropertyStyle;
    }

    // Add text alignment and font weight
    if (cell.col === 1 || cell.row === 1) {
      styleStr += 'text-align: center; ';
    } else {
      // Unaligned cells follow their value: numbers right, text left — except the header of a
      // numeric column, which goes right with the numbers under it.
      const align = cell.align || (numericHeaders.has(cell.name) ? "right" : defaultAlign(typeOf(cell)));
      styleStr += `font-weight: ${cell.fontWeight || "normal"}; text-align: ${align}; `;
    }
    return { styleStr, borderClass };
  };

  const freezeRows = Number(formState?.data?.interaction?.freezeRows) || 0;
  const freezeColumns = Number(formState?.data?.interaction?.freezeColumns) || 0;
  const coloredCells = cells.map(cell => {
    const isFocused = selection.anchor > cell.from && selection.anchor < cell.to;
    const { styleStr, borderClass } = getBorderStyle(cell, isFocused);
    // Use the color from cellColors which includes our focus highlighting
    const focusColor = cellColors[cell.row] && cellColors[cell.row][cell.col];
    const focusTextColor = cellTextColors[cell.row] && cellTextColors[cell.row][cell.col];
    const focusFontWeight = cellFontWeights[cell.row] && cellFontWeights[cell.row][cell.col];
    return {
      ...cell,
      readonly: cell.readonly,
      border: styleStr,
      borderClass: borderClass,
      color: focusColor || ((cell.col === 1 || cell.row === 1) && "#f8f8f8") || "#fff",
      textColor: focusTextColor,
      fontWeight: focusFontWeight,
      sticky: stickyStyle(cell.rect, freezeRows, freezeColumns),
    };
  });
  return applyDecoration({doc, cells: coloredCells});
}

const isTableCellOrHeader = node =>
      node.type.name === "table_cell" ||
      node.type.name === "table_header";

// const isTableCell = node =>
//       node.type.name === "table_cell";

// Every rendered cell, with its 1-based row and column (headings included, so B2 is the first data
// cell) taken from the table map. Counting nodes along a row drifts after a merge: the cell after
// an A1:F1 span is the second node in its row but sits in column G. Only cells with a node are
// here — a covered address has none, and `applyModelRules` builds a node decoration for each
// entry, which a position-less logical blank would break.
export const getCells = (cellExprs, state) => {
  const { doc } = state;
  const cells = [];
  let map = null;
  let tableStart = 0;
  doc.descendants((node, pos) => {
    if (node.type.name === "table") {
      map = TableMap.get(node);
      tableStart = pos + 1;
    }
    if (isTableCellOrHeader(node)) {
      const rect = map ? map.findCell(pos - tableStart) : null;
      const row = rect ? rect.top + 1 : 0;
      const col = rect ? rect.left + 1 : 0;
      const name = node.attrs.name;
      const text = cellExprs && name && cellExprs.cells[name]?.text || node.textContent;
      const val = cellExprs && name && cellExprs.cells[name]?.val;
      const formula = cellExprs && name && cellExprs.cells[name]?.formula;
      const type = cellExprs && name && cellExprs.cells[name]?.type || 'text';
      cells.push({
        row,
        col,
        name,
        text,
        val,
        formula,
        type,
        from: pos,
        to: pos + node.nodeSize,
        align: node.attrs.align || node.attrs.justify,
        background: node.attrs.background,
        'background-color': node.attrs['background-color'],
        'font-weight': node.attrs['font-weight'],
        format: node.attrs.format,
        numberFormat: node.attrs.numberFormat,
        assess: node.attrs.assess,
        underline: node.attrs.underline,
        border: node.attrs.border,
        protected: node.attrs.protected,
        link: node.attrs.link,
        wrap: node.attrs.wrap,
        rect,
      });
    }
  });
  return cells;
};

// const debouncedStateUpdate = debounce(({ state, editorState }) => {
//   state.apply({
//     type: "update",
//     args: {editorState},
//   });
// }, 1000);

export const schema = new Schema({
  nodes: baseSchema.spec.nodes.append(
    tableNodes({
      tableGroup: 'block',
      cellContent: 'paragraph',
      cellAttributes: {
        // These three are read off the node by the renderer; they are deliberately NOT serialized
        // to the DOM. Their previous serializers were broken and never ran — the doc is always
        // built from JSON, never parsed back from the DOM — and they left an attribute literally
        // named `dataset` on every cell.
        name: { default: null },
        format: { default: null },
        assess: { default: null },
        // A web address; the label is drawn as an anchor by a decoration. See applyDecoration.
        link: { default: null },
        // Text wraps unless this is false (the grid's long-standing rendering).
        wrap: {
          default: null,
          setDOMAttr(value, attrs) {
            if (value === false)
              attrs.style = (attrs.style || '') + 'white-space: nowrap; text-overflow: ellipsis;';
          },
        },
        align: {
          default: null,
          getFromDOM(dom) {
            return dom.style.textAlign || null;
          },
          setDOMAttr(value, attrs) {
            if (value)
              attrs.style = (attrs.style || '') + `text-align: ${value};`;
          },
        },
        justify: {
          default: null,
          getFromDOM(dom) {
            return dom.style.textAlign || null;
          },
          setDOMAttr(value, attrs) {
            if (value)
              attrs.style = (attrs.style || '') + `text-align: ${value};`;
          },
        },
        readonly: {
          default: null,
          getFromDOM(dom) {
            return dom.dataset.readonly || null;
          },
          setDOMAttr(value, attrs) {
            if (value) {
              attrs['data-readonly'] = value;
              // Add a CSS class to visually indicate read-only status
              attrs.class = (attrs.class || '') + ' readonly-cell';
            }
          },
        },
        background: {
          default: null,
          getFromDOM(dom) {
            return dom.style.backgroundColor || null;
          },
          setDOMAttr(value, attrs) {
            if (value)
              attrs.style = (attrs.style || '') + `background-color: ${value};`;
          },
        },
        'background-color': {
          default: null,
          getFromDOM(dom) {
            return dom.style.backgroundColor || null;
          },
          setDOMAttr(value, attrs) {
            if (value)
              attrs.style = (attrs.style || '') + `background-color: ${value};`;
          },
        },
        'font-weight': {
          default: null,
          getFromDOM(dom) {
            return dom.style.fontWeight || null;
          },
          setDOMAttr(value, attrs) {
            if (value)
              attrs.style = (attrs.style || '') + `font-weight: ${value};`;
          },
        },
        'font-size': {
          default: null,
          getFromDOM(dom) {
            return dom.style.fontSize || null;
          },
          setDOMAttr(value, attrs) {
            if (value)
              attrs.style = (attrs.style || '') + `font-size: ${value};`;
          },
        },
        'font-family': {
          default: null,
          getFromDOM(dom) {
            return dom.style.fontFamily || null;
          },
          setDOMAttr(value, attrs) {
            if (value)
              attrs.style = (attrs.style || '') + `font-family: ${value};`;
          },
        },
        'font-style': {
          default: null,
          getFromDOM(dom) {
            return dom.style.fontStyle || null;
          },
          setDOMAttr(value, attrs) {
            if (value)
              attrs.style = (attrs.style || '') + `font-style: ${value};`;
          },
        },
        color: {
          default: null,
          getFromDOM(dom) {
            return dom.style.color || null;
          },
          setDOMAttr(value, attrs) {
            if (value)
              attrs.style = (attrs.style || '') + `color: ${value};`;
          },
        },
        'text-decoration': {
          default: null,
          getFromDOM(dom) {
            return dom.style.textDecoration || null;
          },
          setDOMAttr(value, attrs) {
            if (value)
              attrs.style = (attrs.style || '') + `text-decoration: ${value};`;
          },
        },
        'vertical-align': {
          default: null,
          getFromDOM(dom) {
            return dom.style.verticalAlign || null;
          },
          setDOMAttr(value, attrs) {
            if (value)
              attrs.style = (attrs.style || '') + `vertical-align: ${value};`;
          },
        },
        height: {
          default: null,
          getFromDOM(dom) {
            return dom.style.height || null;
          },
          setDOMAttr(value, attrs) {
            if (value) {
              // Use 'auto' for height to allow content to determine height
              // or use the specified value if provided
              const heightValue = value === 'auto' ? 'auto' : value;
              attrs.style = (attrs.style || '') + `height: ${heightValue}; min-height: 24px;`;
            } else {
              // Default behavior - let content determine height with minimum
              attrs.style = (attrs.style || '') + `height: auto; min-height: 24px;`;
            }
          },
        },
        underline: {
          default: null,
          getFromDOM(dom) {
            return dom.style.borderBottom || null;
          },
          setDOMAttr(value, attrs) {
            if (value)
              attrs.style = (attrs.style || '') + `border-bottom: 1px solid black;`;
          },
        },
        border: {
          default: null,
          getFromDOM(dom) {
            return dom.dataset.border || null;
          },
          setDOMAttr(value, attrs) {
            if (value && typeof value === 'string') {
              // Just store the border value as data attribute
              // The actual rendering is handled in getBorderStyle
              attrs['data-border'] = value;
            }
          },
        },
        protected: {
          default: false,
          getFromDOM(dom) {
            return dom.dataset.protected === 'true';
          },
          setDOMAttr(value, attrs) {
            if (value) {
              attrs['data-protected'] = 'true';
              // Add a CSS class to visually indicate protected status and hide cursor
              attrs.class = (attrs.class || '') + ' protected-cell';
              attrs.style = (attrs.style || '') + 'caret-color: transparent;';
            }
          },
        },
      },
    }),
  ),
  // No marks. The language expresses emphasis as cell attributes (`font-weight`, `font-style`),
  // not as inline document marks, so the base schema's link/em/strong/code were unreachable.
  marks: {},
});

const findTable = $pos => {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === "table") {
      return { pos: $pos.before(depth), node };
    }
  }
  return null;
}

const getTablePosition = state => {
  const { $from } = state.selection;
  const table = findTable($from);
  return table ? table.pos : null;
}

const letters = "_ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

const getCellRowColFromName = name => {
  const colName = name.slice(0, 1);
  const rowName = name.slice(1);
  const col = letters.indexOf(colName);
  const row = +rowName;
  return {row, col};
};

export const getCellNodeByName = ({ state, name }) => {
  const tablePos = getTablePosition(state);
  const tableNode = state.doc.nodeAt(tablePos);
  const tableMap = TableMap.get(tableNode);
  const { row, col } = getCellRowColFromName(name);
  const cellIndex = row * tableMap.width + col;
  const cellPos = tableMap.map[cellIndex] + tablePos + 1;
  const cellNode = state.doc.nodeAt(cellPos);
  return {node: cellNode, pos: cellPos};
}

export const getAdjacentCellNodeByName = ({ state, name }) => {
  const { row, col } = getCellRowColFromName(name);
  const adjRow = row === 0 && row + 1 || row;
  const adjCol = col === 0 && col + 1 || col;
  const adjName = `${letters[adjCol]}${adjRow}`;
  return getCellNodeByName({state, name: adjName});
}

// const getCellNodeByName = ({doc, name}) => {
//   let result;
//   doc.descendants((node, pos) => {
//     if (result !== undefined) {
//       return false;
//     }
//     if (isTableCellOrHeader(node) && node.attrs.name === name) {
//       result = {node, pos};
//     }
//   });
//   result = result || {};
//   return result;
// };

/**
 * Write formatted text into many cells in ONE transaction.
 *
 * Doing it per cell is what made a cold mount expensive out of all proportion to the sheet: every
 * non-empty cell was marked dirty, each got its own `replaceCellContent`, and each dispatch
 * re-entered the plugin's `apply` — which rebuilds the decorations for the WHOLE sheet and
 * rescores it. So the number of full-sheet rebuilds at mount was the number of populated cells.
 *
 * Positions are resolved against the pre-change document and then mapped forward, because each
 * replacement shifts everything after it.
 */
const replaceCellContents = (editorView, updates) => {
  const { state, dispatch } = editorView;
  const tr = state.tr;
  tr.setMeta("systemFormatting", true);
  for (const { name, text } of updates) {
    const { pos, node } = getCellNodeByName({ state, name });
    if (!node || !isTableCellOrHeader(node)) continue;
    const from = tr.mapping.map(pos + 1);
    const to = tr.mapping.map(pos + node.nodeSize - 1);
    const paragraphNode = text &&
      state.schema.node("paragraph", null, state.schema.text(text)) ||
      state.schema.node("paragraph");
    tr.replaceWith(from, to, paragraphNode);
  }
  if (tr.docChanged) dispatch(tr);
};

const replaceCellContent = (editorView, name, newText, doMoveCursor = false) => {
  const { state, dispatch } = editorView;
  const { pos: cellPos, node: cellNode } = getCellNodeByName({state, name});
  if (!cellNode || !isTableCellOrHeader(cellNode)) {
    console.error("Invalid cell position or node type: " + JSON.stringify(cellNode, null, 2));
    return;
  }
  const contentStart = cellPos + 1;
  const contentEnd = cellPos + cellNode.nodeSize - 1;
  const paragraphNode = newText &&
        state.schema.node("paragraph", null, state.schema.text(newText)) ||
        state.schema.node("paragraph");
  const tr = state.tr;
  // Mark this as a system formatting update, not user input
  tr.setMeta("systemFormatting", true);
  tr.replaceWith(contentStart, contentEnd, paragraphNode);
  if (doMoveCursor) {
    const cursorPos = contentStart + 1;
    tr.setSelection(TextSelection.create(tr.doc, cursorPos + newText.length));
  }
  dispatch(tr);
}

const makeTableHeadersReadOnlyPlugin = (formState) => new Plugin({
  view(editorView) {
    // Add a capture phase event listener to catch shift-clicks and cmd/ctrl-clicks on headers and cells
    const handleModifierClick = (event) => {
      // Check for shift-click (range selection) or cmd/ctrl-click (toggle selection)
      const isShiftClick = event.shiftKey;
      const isToggleClick = event.metaKey || event.ctrlKey; // metaKey for Mac, ctrlKey for Windows/Linux

      if (!isShiftClick && !isToggleClick) return;

      // Find if we clicked on a header or cell
      const target = event.target;
      let headerElement = target;

      // Walk up the DOM tree to find a table header or cell
      while (headerElement && headerElement !== editorView.dom) {
        if (headerElement.nodeName === 'TH' || headerElement.classList?.contains('ProseMirror-tableheader') ||
            headerElement.nodeName === 'TD' || headerElement.classList?.contains('ProseMirror-tablecell')) {
          // Get position in ProseMirror document
          const pos = editorView.posAtDOM(headerElement, 0);
          const $pos = editorView.state.doc.resolve(pos);

          // Find the header or cell node
          for (let depth = $pos.depth; depth > 0; depth--) {
            const node = $pos.node(depth);
            if (node.type.name === "table_cell") {
              // Handle modifier-click on table cells
              const cellName = node.attrs.name;
              const currentFocus = formState.data.focus;

              if (isToggleClick) {
                // Cmd/Ctrl-click: Toggle selection of individual cells
                let selectedCells = [];

                if (currentFocus && currentFocus.type === "cell") {
                  if (currentFocus.cells && currentFocus.cells.length > 0) {
                    // Already have multiple cells selected
                    selectedCells = [...currentFocus.cells];
                  } else if (currentFocus.name) {
                    // Single cell selected - convert to array
                    selectedCells = currentFocus.name.split(',').map(c => c.trim());
                  }
                }

                // Toggle the clicked cell
                const cellIndex = selectedCells.indexOf(cellName);
                if (cellIndex > -1) {
                  // Remove cell if already selected
                  selectedCells.splice(cellIndex, 1);
                } else {
                  // Add cell if not selected
                  selectedCells.push(cellName);
                }

                if (selectedCells.length > 0) {
                  formState.apply({
                    type: "focus",
                    args: {
                      type: "cell",
                      name: selectedCells.join(','),
                      cells: selectedCells,
                      isRange: false,  // Not a contiguous range
                      isMultiple: true,  // Multiple individual selections
                    },
                  });
                } else {
                  // No cells selected - clear focus
                  formState.apply({
                    type: "focus",
                    args: null,
                  });
                }

                // Update decorations
                const tr = editorView.state.tr;
                tr.setMeta("focusChanged", true);
                editorView.dispatch(tr);

                event.preventDefault();
                event.stopPropagation();
                return;

              } else if (isShiftClick && currentFocus && currentFocus.type === "cell") {
                // Shift-click: Create range selection
                let startCell = null;

                if (currentFocus.isRange && currentFocus.cells && currentFocus.cells.length > 0) {
                  // Use the first cell of the range as the anchor
                  startCell = currentFocus.cells[0];
                } else if (currentFocus.name && !currentFocus.name.includes(',')) {
                  // Single cell selected
                  startCell = currentFocus.name;
                }

                if (startCell && startCell !== cellName) {
                  const rangeCells = getCellRange(startCell, cellName);

                  if (rangeCells.length > 0) {
                    formState.apply({
                      type: "focus",
                      args: {
                        type: "cell",
                        name: rangeCells.join(','),  // Send as comma-separated list
                        cells: rangeCells,  // Also include array for internal use
                        isRange: true,  // Flag to indicate this is a range
                      },
                    });

                    // Update decorations
                    const tr = editorView.state.tr;
                    tr.setMeta("focusChanged", true);
                    editorView.dispatch(tr);

                    event.preventDefault();
                    event.stopPropagation();
                    return;
                  }
                }
              }
              break;
            } else if (node.type.name === "table_header") {
              const name = node.attrs.name;
              const colPart = name?.match(/^([_A-Z]+)/)?.[1];
              const rowPart = name?.match(/(\d+)$/)?.[1];

              if (colPart && colPart !== "_" && rowPart === "0") {
                // Column header click
                const currentFocus = formState.data.focus;

                if (isToggleClick) {
                  // Cmd/Ctrl-click: Toggle column selection
                  let selectedColumns = [];

                  if (currentFocus && currentFocus.type === "column") {
                    if (currentFocus.columns && currentFocus.columns.length > 0) {
                      selectedColumns = [...currentFocus.columns];
                    } else if (currentFocus.name) {
                      selectedColumns = [currentFocus.name];
                    }
                  }

                  // Toggle the clicked column
                  const colIndex = selectedColumns.indexOf(colPart);
                  if (colIndex > -1) {
                    selectedColumns.splice(colIndex, 1);
                  } else {
                    selectedColumns.push(colPart);
                  }

                  if (selectedColumns.length > 0) {
                    formState.apply({
                      type: "focus",
                      args: {
                        type: "column",
                        name: selectedColumns[0], // First column as anchor
                        columns: selectedColumns,
                        isMultiple: true,
                      },
                    });
                  } else {
                    formState.apply({
                      type: "focus",
                      args: null,
                    });
                  }

                  // Update decorations
                  const tr = editorView.state.tr;
                  tr.setMeta("focusChanged", true);
                  tr.setMeta("headerClick", true);
                  editorView.dispatch(tr);

                  event.preventDefault();
                  event.stopPropagation();
                  return;

                } else if (isShiftClick && currentFocus && currentFocus.type === "column" && currentFocus.name) {
                  // Shift-click: Create range from anchor column to clicked column
                  const rangeColumns = getColumnRange(currentFocus.name, colPart);

                  formState.apply({
                    type: "focus",
                    args: {
                      type: "column",
                      name: currentFocus.name, // Keep original anchor
                      columns: rangeColumns,
                    },
                  });

                  // Update decorations
                  const tr = editorView.state.tr;
                  tr.setMeta("focusChanged", true);
                  tr.setMeta("headerClick", true);
                  editorView.dispatch(tr);

                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
              } else if (colPart === "_" && rowPart && rowPart !== "0") {
                // Row header click
                const currentFocus = formState.data.focus;

                if (isToggleClick) {
                  // Cmd/Ctrl-click: Toggle row selection
                  let selectedRows = [];

                  if (currentFocus && currentFocus.type === "row") {
                    if (currentFocus.rows && currentFocus.rows.length > 0) {
                      selectedRows = [...currentFocus.rows];
                    } else if (currentFocus.name) {
                      selectedRows = [currentFocus.name];
                    }
                  }

                  // Toggle the clicked row
                  const rowIndex = selectedRows.indexOf(rowPart);
                  if (rowIndex > -1) {
                    selectedRows.splice(rowIndex, 1);
                  } else {
                    selectedRows.push(rowPart);
                  }

                  if (selectedRows.length > 0) {
                    formState.apply({
                      type: "focus",
                      args: {
                        type: "row",
                        name: selectedRows[0], // First row as anchor
                        rows: selectedRows,
                        isMultiple: true,
                      },
                    });
                  } else {
                    formState.apply({
                      type: "focus",
                      args: null,
                    });
                  }

                  // Update decorations
                  const tr = editorView.state.tr;
                  tr.setMeta("focusChanged", true);
                  tr.setMeta("headerClick", true);
                  editorView.dispatch(tr);

                  event.preventDefault();
                  event.stopPropagation();
                  return;
                } else if (isShiftClick && currentFocus && currentFocus.type === "row" && currentFocus.name) {
                  // Shift-click: Create range selection
                  const rangeRows = getRowRange(currentFocus.name, rowPart);

                  formState.apply({
                    type: "focus",
                    args: {
                      type: "row",
                      name: currentFocus.name, // Keep original anchor
                      rows: rangeRows,
                    },
                  });

                  // Update decorations
                  const tr = editorView.state.tr;
                  tr.setMeta("focusChanged", true);
                  tr.setMeta("headerClick", true);
                  editorView.dispatch(tr);

                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
              }
              break;
            }
          }
          break;
        }
        headerElement = headerElement.parentElement;
      }
    };

    // Add listener in capture phase to intercept before ProseMirror
    editorView.dom.addEventListener('mousedown', handleModifierClick, true);

    return {
      destroy() {
        editorView.dom.removeEventListener('mousedown', handleModifierClick, true);
      }
    };
  },
  props: {
    handleClickOn(view, _pos, node, _nodePos, event, _direct) {
      const { state, dispatch } = view;

      // Check if the clicked node is a `table_header`
      if (node.type.name === "table_header") {
        // If shift is held, let the capture phase handler deal with it
        if (event && event.shiftKey) {
          return false; // Let other handlers process this
        }
        // Create a selection for the adjacent cell instead
        const name = node.attrs.name || "_0";

        // Dispatch focus action for header click
        if (name) {
          // Parse the cell name to determine column and row
          const colPart = name.match(/^([_A-Z]+)/)?.[1];
          const rowPart = name.match(/(\d+)$/)?.[1];

          if (colPart === "_" && rowPart === "0") {
            // Top-left corner header (_0)
            formState.apply({
              type: "focus",
              args: {
                type: "sheet",
              },
            });
            // Force re-render to update decorations with new focus
            const updateTr = state.tr;
            updateTr.setMeta("focusChanged", true);
            updateTr.setMeta("headerClick", true);
            dispatch(updateTr);
          } else if (colPart && colPart !== "_" && rowPart === "0") {
            // Column header (e.g., A0, B0, C0)
            // Single column selection (replace existing)
            formState.apply({
              type: "focus",
              args: {
                type: "column",
                name: colPart,
                columns: [colPart], // Also store as array for consistency
              },
            });
            // Force re-render to update decorations with new focus
            const updateTr = state.tr;
            updateTr.setMeta("focusChanged", true);
            updateTr.setMeta("headerClick", true);
            dispatch(updateTr);
          } else if (colPart === "_" && rowPart && rowPart !== "0") {
            // Row header (e.g., _1, _2, _3)
            formState.apply({
              type: "focus",
              args: {
                type: "row",
                name: rowPart,
                rows: [rowPart], // Store as array for consistency
              },
            });
            // Force re-render to update decorations with new focus
            const updateTr = state.tr;
            updateTr.setMeta("focusChanged", true);
            updateTr.setMeta("headerClick", true);
            dispatch(updateTr);
          }
        }

        const { pos: adjPos, node: adjNode } = getAdjacentCellNodeByName({state, name});
        if (adjPos && adjNode) {
          const cursorPos = adjPos + 2;
          const newText = adjNode.textContent;
          const selection = TextSelection.create(state.tr.doc, cursorPos + newText.length);

          // Dispatch the transaction with a meta flag indicating this is a synthetic focus
          const tr = state.tr.setSelection(selection);
          tr.setMeta("syntheticFocus", true);
          dispatch(tr);
        }
        return true; // Prevent further handling
      }

      return false; // Allow other events to be handled normally
    },

    handleDOMEvents: {
      mousedown(view, event) {
        // This handler is now redundant since we use capture phase listener
        // But keeping it for backward compatibility with non-shift clicks
        if (!event.shiftKey) return false;

        // Get the position in the document from the mouse event
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (!pos) {
          return false;
        }

        // Get the node at this position
        const $pos = view.state.doc.resolve(pos.pos);
        let headerNode = null;
        let headerName = null;

        // Find the table header node
        for (let depth = $pos.depth; depth > 0; depth--) {
          const node = $pos.node(depth);
          if (node.type.name === "table_header") {
            headerNode = node;
            headerName = node.attrs.name;
            break;
          }
        }

        if (headerNode && headerName) {
          const { state, dispatch } = view;
          const name = headerName;

          // Parse the cell name to determine column and row
          const colPart = name.match(/^([_A-Z]+)/)?.[1];
          const rowPart = name.match(/(\d+)$/)?.[1];

          if (colPart && colPart !== "_" && rowPart === "0") {
            // Column header (e.g., A0, B0, C0)
            const currentFocus = formState.data.focus;

            // Check if shift key is held for discontiguous selection
            if (event.shiftKey && currentFocus && currentFocus.type === "column") {
              // Add to existing column selection
              const selectedColumns = currentFocus?.columns || (currentFocus?.name ? [currentFocus?.name] : []);
              const newColumns = selectedColumns.includes(colPart)
                ? selectedColumns.filter(col => col !== colPart) // Toggle off if already selected
                : [...selectedColumns, colPart]; // Add to selection

              formState.apply({
                type: "focus",
                args: {
                  type: "column",
                  columns: newColumns,
                },
              });

              // Force re-render to update decorations with new focus
              const updateTr = state.tr;
              updateTr.setMeta("focusChanged", true);
              updateTr.setMeta("headerClick", true);
              dispatch(updateTr);
              event.preventDefault();
              return true; // Prevent default handleClickOn from running
            }
          }
        }
        return false; // Let normal processing continue
      },
      beforeinput(view, event) {
        if (isInsideTableHeader(view.state)) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      keydown(view, event) {
        const { state, dispatch } = view;

        // Check if we're in a header cell already
        if (isInsideTableHeader(state)) {
          event.preventDefault();

          // If it's tab, use our reliable tab handler
          if (event.key === 'Tab') {
            const dir = event.shiftKey ? -1 : 1;
            skipHeadersGoToNextCell(dir)(state, dispatch);
            return true;
          }

          // For all other cases, try to move to B2 (first data cell)
          const { pos } = getCellNodeByName({state, name: "B2"});
          if (pos) {
            const tr = state.tr;
            const resolvedPos = state.doc.resolve(pos);
            // Mark this as our redirected transaction to prevent recursion
            tr.setMeta("_headerRedirect", true);
            tr.setSelection(new TextSelection(resolvedPos));
            dispatch(tr);
          }

          return true; // Prevent default handling
        }

        // For all navigation keys, check if they would move into a header
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
          // The current cell's rectangle, so a merged cell is judged by its edges, not its anchor.
          const at = cellRectAt(state);
          if (at) {
            const { rect, map } = at;
            // Check if the move would end up in a header
            if ((event.key === 'ArrowUp' && rect.top === 1) ||
                (event.key === 'ArrowLeft' && rect.left === 1)) {
              event.preventDefault();
              return true; // Block the navigation
            }
            // Block navigation at edges to prevent wrapping to headers
            if ((event.key === 'ArrowRight' && rect.right === map.width) ||
                (event.key === 'ArrowDown' && rect.bottom === map.height)) {
              event.preventDefault();
              return true; // Block navigation at the edge
            }
          }
        }

        return false;
      },
      copy(_view, _event) {
        // Still allow copying from headers
        return false;
      },
      paste(view, event) {
        if (isInsideTableHeader(view.state)) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      cut(view, event) {
        if (isInsideTableHeader(view.state)) {
          event.preventDefault();
          return true;
        }
        return false;
      }
    }
  },

  filterTransaction(tr, state) {
    // Skip our own redirected transactions - add a meta flag to prevent recursion
    if (tr.getMeta("_headerRedirect")) {
      return true;
    }

    // Any step at all inside a header is refused.
    //
    // The `stepType === "setSelection"` test below reads as "allow selection changes", but a
    // selection is NOT a step in ProseMirror — it rides alongside them — so nothing ever matches
    // and `isSelectionOnly` is false whenever there is a step. That is the behaviour relied on;
    // selection-only transactions have `steps.length === 0` and never reach here. Left as-is
    // because making the test mean what it says would change what gets through.
    if (tr.steps.length > 0 && isInsideTableHeader(state)) {
      const isSelectionOnly = tr.steps.every(step => step.toJSON().stepType === "setSelection");
      return isSelectionOnly;
    }

    // For selection-only transactions, check if they would land in a header
    // WITHOUT applying the transaction (which would cause recursion)
    if (tr.selectionSet) {
      // Check if this would land in a header by examining the position directly
      const $pos = tr.selection.$anchor;
      if ($pos) {
        for (let depth = $pos.depth; depth > 0; depth--) {
          const node = $pos.node(depth);
          if (node && node.type.name === "table_header") {
            return false; // Cancel the transaction
          }
        }

        // Also check if this is an attempt to wrap around the table
        // by preventing selection of cell at position 0,0
        if ($pos.pos === 1) {
          return false; // Cancel any transaction that tries to select the first position
        }
      }
    }

    return true;
  }
});

// Helper function to check if current selection is inside a table header
function isInsideTableHeader(state) {
  const { selection } = state;
  return isPosInHeader(state, selection.$anchor.pos);
}

// Helper function to check if current selection is inside a protected cell
function isInsideProtectedCell(state) {
  const { selection } = state;
  const $pos = state.doc.resolve(selection.$anchor.pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === "table_cell" && node.attrs.protected === true) {
      return true;
    }
  }
  return false;
}

/** Whether any protected cell lies in [from, to], or contains it. */
export const touchesProtectedCell = (doc, from, to) => {
  let found = false;
  const end = Math.min(Math.max(from, to), doc.content.size);
  doc.nodesBetween(Math.max(0, Math.min(from, to)), end, node => {
    if (found) return false;
    if (node.type.name === "table_cell" && node.attrs.protected === true) found = true;
    return !found;
  });
  return found;
};

export const makeProtectedCellsPlugin = (tooltipHandler) => new Plugin({
  props: {
    handleDOMEvents: {
      beforeinput(view, event) {
        if (isInsideProtectedCell(view.state)) {
          event.preventDefault();
          tooltipHandler?.showTooltip(event);
          return true;
        }
        return false;
      },
      input(view, event) {
        if (isInsideProtectedCell(view.state)) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      keypress(view, event) {
        if (isInsideProtectedCell(view.state)) {
          event.preventDefault();
          tooltipHandler?.showTooltip(event);
          return true;
        }
        return false;
      },
      keydown(view, event) {
        if (isInsideProtectedCell(view.state)) {
          // Allow navigation keys but block content modification
          const allowedKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter', 'Escape', 'Home', 'End', 'PageUp', 'PageDown'];
          const isNavigationKey = allowedKeys.includes(event.key);
          const isModifierKey = event.metaKey || event.ctrlKey || event.altKey;
          // Allow navigation keys and modifier combinations (like Ctrl+C)
          if (!isNavigationKey && !isModifierKey) {
            event.preventDefault();
            tooltipHandler?.showTooltip(event);
            return true;
          }
          // Allow specific modifier combinations for copy operations
          if (isModifierKey && ['c', 'C', 'v', 'V', 'x', 'X', 'a', 'A', 'z', 'Z', 'y', 'Y'].includes(event.key)) {
            // Allow copy (Ctrl+C), but prevent paste (Ctrl+V), cut (Ctrl+X), and undo/redo
            if (['v', 'V', 'x', 'X', 'z', 'Z', 'y', 'Y'].includes(event.key)) {
              event.preventDefault();
              tooltipHandler?.showTooltip(event);
              return true;
            }
          }
        }
        return false;
      },
      paste(view, event) {
        if (isInsideProtectedCell(view.state)) {
          event.preventDefault();
          tooltipHandler?.showTooltip(event);
          return true;
        }
        return false;
      },
      cut(view, event) {
        if (isInsideProtectedCell(view.state)) {
          event.preventDefault();
          tooltipHandler?.showTooltip(event);
          return true;
        }
        return false;
      },
      drop(view, event) {
        if (isInsideProtectedCell(view.state)) {
          event.preventDefault();
          tooltipHandler?.showTooltip(event);
          return true;
        }
        return false;
      }
    }
  },

  filterTransaction(tr, state) {
    // Allow system formatting updates for protected cells
    if (tr.getMeta("systemFormatting")) {
      return true;
    }
    // Check if this transaction would modify content inside a protected cell
    if (tr.steps.length > 0) {
      // Check if any step would affect a protected cell
      for (const step of tr.steps) {
        const stepJSON = step.toJSON();
        // As in the headers plugin: a selection is not a step, so this test never excludes
        // anything and the rule is really "any step at all while inside a protected cell".
        if (stepJSON.stepType !== "setSelection" && isInsideProtectedCell(state)) {
          return false;
        }
        // Also check every cell the step's range touches. Resolving only `from` missed a
        // selection anchored outside any cell: Select All, then typing, replaced the whole table,
        // protected cells included, because position 0 is inside no cell at all.
        if (stepJSON.from !== undefined && touchesProtectedCell(state.doc, stepJSON.from, stepJSON.to ?? stepJSON.from)) {
          return false;
        }
      }
    }

    return true;
  }
});


export const buildCellPlugin = formState => {
  let initialUpdateSent = false;
  // Addresses hidden under a merge. They have no node, so a write addressed to one must be
  // skipped: `getCellNodeByName` resolves a covered position to the ANCHOR's node, and writing
  // there would put B1's text into A1.
  const { covered } = spansOf(formState?.data?.interaction?.cells);
  const self = new Plugin({
    view(_editorView) {
      return {
        update(view) {
          const { state, dispatch } = view;
          const pluginState = self.getState(state);
          if (pluginState.dirtyCells.length > 0) {
            const tr = state.tr;
            tr.setMeta("updated", true);
            dispatch(tr);
          } else if (!initialUpdateSent) {
            // Send initial update after dirty cells are processed
            initialUpdateSent = true;
            const cells = pluginState.cells || {};
            // Not the logical blanks under a merge: they are the engine's, not the model's.
            const allCellNames = Object.keys(cells).filter(name => !covered.has(name));
            if (allCellNames.length > 0) {
              formState.apply({
                type: "update",
                args: {
                  cells: getChangedCells(cells, allCellNames, pluginState.cache),
                },
              });
            }
          }
          const cells = {...pluginState.cells};
          const { columns, cells: interactionCells, rows } = formState.data.interaction;
          // First merge cell attributes from formState
          if (interactionCells) {
            Object.keys(cells).forEach(cellName => {
              const interactionCell = interactionCells[cellName];
              const format = interactionCell?.attrs?.format;
              if (format) {
                cells[cellName] = {
                  ...cells[cellName],
                  format: format,
                };
              }
            });
          }
          // Then merge column attributes into cells
          Object.keys(cells).forEach(cellName => {
            const colName = cellName.slice(0, 1); // Extract column letter (A, B, C, etc.)
            const rowNum = parseInt(cellName.slice(1));

            // Skip header row (row 1) when applying column attributes
            if (rowNum <= 1) {
              return;
            }

            const columnAttrs = columns && columns[colName];
            if (columnAttrs) {
              // Merge any column attributes that aren't already set on the cell
              Object.keys(columnAttrs).forEach(attr => {
                if (columnAttrs[attr] !== undefined && !cells[cellName]?.[attr]) {
                  cells[cellName] = {
                    ...cells[cellName],
                    [attr]: columnAttrs[attr],
                  };
                }
              });
            }
          });
          // Then merge row attributes into cells
          Object.keys(cells).forEach(cellName => {
            const rowNum = parseInt(cellName.slice(1));

            // Skip invalid row numbers
            if (!rowNum || rowNum <= 0) {
              return;
            }

            const rowAttrs = rows && rows[rowNum];
            if (rowAttrs) {
              // Merge any row attributes that aren't already set on the cell
              Object.keys(rowAttrs).forEach(attr => {
                if (rowAttrs[attr] !== undefined && !cells[cellName]?.[attr]) {
                  cells[cellName] = {
                    ...cells[cellName],
                    [attr]: rowAttrs[attr],
                  };
                }
              });
            }
          });
          // Collected, then written in ONE transaction. A dispatch per cell meant a full-sheet
          // decoration rebuild and rescore per cell, so a cold mount paid that once for every
          // populated cell in the sheet.
          const pending = [];
          pluginState.dirtyCells.forEach(name => {
            if (covered.has(name)) return;
            cells[name] = {
              ...cells[name],
              ...evalCell({ env: {cells}, name, cache: pluginState.cache }),
            };
            const formattedVal = fixText(formatCellValue({env: {cells}, name, cache: pluginState.cache}));
            const { node } = getCellNodeByName({state: view.state, name});
            if (name !== pluginState.focusedCell && formattedVal !== node.textContent) {
              pending.push({ name, text: formattedVal });
            }
          });
          if (pending.length) replaceCellContents(view, pending);
          if (pluginState.focusedCell && !covered.has(pluginState.focusedCell)) {
            const name = pluginState.focusedCell;
            const text = fixText(pluginState.cells[name]?.text || "");
            const { node } = getCellNodeByName({state: view.state, name});
            if (node.type.name === "table_cell" && text !== node.textContent) {
              replaceCellContent(view, name, text, true);
            }
          }
        }
      };
    },
    state: {
      init(_config, state) {
        // Reset initialUpdateSent so that when editor is reinitialized with new cells,
        // the initial update will be sent again
        initialUpdateSent = false;
        const cellExprs = self.getState(state);
        // One document walk, not three. `getCells` is a full `doc.descendants` traversal that
        // allocates an object per cell, and this ran it once for each of the three maps below.
        const allDocCells = getCells(cellExprs, state);
        // Both accumulators mutate one local instead of spreading per cell: the `{...cells}` and
        // `[...dirtyCells]` forms were O(N^2) over every cell in the sheet.
        const cells = {};
        for (const cell of allDocCells) {
          if (cell.row > 1 && cell.col > 1) cells[cell.name] = { ...cell, deps: [] };
        }
        // Every address under a merge is still a cell to the engine: an empty one. Without it a
        // formula reading B1 under an A1:F1 merge reads a cell that does not exist, which is not
        // the same as an empty one — with A1=5, `=A1*B1` gave 51 instead of 5 when B1 went
        // missing. Added here only, never to `getCells`: they have no node and no position.
        for (const name of covered.keys()) {
          if (cells[name]) continue;
          cells[name] = {
            name,
            text: "",
            type: "text",
            row: +name.slice(1) + 1,
            col: columnIndex(name.slice(0, 1)) + 1,
            covered: true,
            deps: [],
          };
        }
        const dirtyCells = [];
        for (const cell of allDocCells) {
          if (cell.row > 1 && cell.col > 1 && cell.text) dirtyCells.push(cell.name);
        }
        // Evaluate in dependency order, each cell exactly once.
        //
        // What this replaces asked every cell for its transitive dependencies and then evaluated
        // EACH of them, so a cell five others read was parsed five times — measured at 5x the
        // necessary number of parses on a chained sheet, and a parse costs 3-17 ms. The graph and
        // the memo live on plugin state so an edit can reuse both.
        const graph = buildGraph(cells);
        const cache = createSheetCache();
        const evaluated = recalculate({ cells, graph, changed: dirtyCells, cache }).cells;

        // `deps` is this codebase's name for the REVERSE edge — who reads this cell — which the
        // graph now holds directly. Rebuilt from it rather than accumulated by hand, which is
        // what the two nested reduces here used to do with a whole-map spread per dependency.
        const allCells = {};
        for (const name of Object.keys(evaluated)) {
          const readers = graph.dependents.get(name);
          allCells[name] = { ...evaluated[name], deps: readers ? [...readers] : [] };
        }
        const value = {
          lastFocusedCell: null,
          blurredCell: null,
          focusedCell: null,
          lastHeaderClick: 0,
          dirtyCells,
          cells: allCells,
          graph,
          cache,
          // Seeded from the model this editor state was built from; afterwards it moves only by
          // the "feedback" meta TableEditor dispatches, because `formState` here is the one this
          // plugin was built with and never sees a later check.
          showFeedback: showsFeedback(formState.data),
        };
        const validation = formState.data?.validation || null;
        const decorations = applyModelRules(cellExprs, state, value, validation, formState);
        return {
          ...value,
          decorations,
        }
      },
      apply(tr, value, _oldState, state) {
        // What the decorations were computed from on the way in, so the tail can tell whether
        // anything they depend on actually moved.
        const before = value;
        const feedback = tr.getMeta("feedback");
        if (feedback !== undefined && feedback !== value.showFeedback) {
          value = { ...value, showFeedback: feedback };
        }
        if (tr.getMeta("updated")) {
          value = {
            ...value,
            focusedCell: null,
            dirtyCells: [],
          };
        }
        // Track header clicks
        if (tr.getMeta("headerClick")) {
          value = {
            ...value,
            lastHeaderClick: Date.now(),
          };
        }
        // Force recalculation of decorations when focus changes
        if (tr.getMeta("focusChanged") || tr.getMeta("focusCleared") || tr.getMeta("headerClick")) {
          const cellExprs = self.getState(state);
          const { validation } = formState.data;
          const decorations = applyModelRules(cellExprs, state, value, validation, formState);
          return {
            ...value,
            decorations,
          };
        }
        const { selection } = state;
        const $anchor = selection.$anchor;
        const node = $anchor.node(-1);
        const name = node.attrs?.name;
        const lastFocusedCell = value.lastFocusedCell;
        if (lastFocusedCell !== name) {
          // We just left a cell, so compute its value, add to its dependencies
          // dependents list (`deps`), and recompute the value of its dependents.
          // console.log(
          //   "cellPlugin/apply()",
          //   "state=" + JSON.stringify(state, null, 2),
          //   "value=" + JSON.stringify(value, null, 2),
          //   "formState=" + JSON.stringify(formState, null, 2),
          // );
          if (lastFocusedCell && value.cells[lastFocusedCell]) {
            const cell = value.cells[lastFocusedCell];
            // The edited cell's references may have changed with its text, so re-point its edges
            // before recalculating. O(deps), not a rebuild.
            const graph = value.graph;
            setFormula(graph, lastFocusedCell, cell.text || "", value.cells);

            // One ordered pass over the edited cell and everything that transitively reads it,
            // each evaluated exactly once. What this replaces was three stacked reduces — the
            // cell, then every PRECEDENT re-evaluated to rebuild the reverse edge by hand, then
            // every direct dependent — each iteration spreading the entire cell map.
            //
            // It also propagates further than the old code did: that version refreshed only the
            // DIRECT dependents, and left anything further down the chain to be picked up by the
            // dirty-cell sweep in `view.update`.
            const out = recalculate({
              cells: value.cells,
              graph,
              changed: [lastFocusedCell],
              cache: value.cache,
            });

            const cells = {};
            for (const name of Object.keys(out.cells)) {
              const readers = graph.dependents.get(name);
              cells[name] = { ...out.cells[name], deps: readers ? [...readers] : [] };
            }

            value = {
              ...value,
              blurredCell: lastFocusedCell,
              cells,
              dirtyCells: [
                // INHERITED FROM L0166: `?.` guards the object, not the property — spreading `...value?.dirtyCells`
                // throws when the property is undefined instead of short-circuiting. Fixing it is a
                // behaviour change for the grid, so it stays flagged here rather than quietly corrected.
                // eslint-disable-next-line no-unsafe-optional-chaining
                ...value?.dirtyCells,
                lastFocusedCell,  // Order matters.
                ...out.changed,
              ],
            };
          }
          value = {
            ...value,
            lastFocusedCell: node.attrs.name,
            focusedCell: node.attrs.name,
          };
          const cells = getResponses(value.cells);
          formState.apply({
            type: "response",
            args: {
              cells,
            },
          });
          // Dispatch update for changed cells and their dependents
          if (lastFocusedCell) {
            const changedCellNames = [
              lastFocusedCell,
              ...(value.cells[lastFocusedCell]?.deps || []),
            ];
            formState.apply({
              type: "update",
              args: {
                cells: getChangedCells(value.cells, changedCellNames, value.cache),
              },
            });
          }
          // Apply focus action only for explicit (non-synthetic) cell focus changes
          if (node.attrs.name && !tr.getMeta("syntheticFocus")) {
            // Clear any row/column focus by setting cell focus
            formState.apply({
              type: "focus",
              args: {
                type: "cell",
                name: node.attrs.name,
              },
            });
          }
        } else if (isTableCellOrHeader(node) && node.attrs?.name) {
          const name = node.attrs.name;
          const text = node.textContent.trim();
          value = {
            ...value,
            blurredCell: null,
            focusedCell: null,
            dirtyCells: [],
            cells: {
              ...value.cells,
              [name]: {
                ...value.cells[name],
                ...evalCell({env: value, name}),
                text,
                formula: text,
                // TODO: Add normalized value to cell state
                // normalizedValue,
              },
            },
          };
        }
        // Rebuilding is O(cells) and drags a full rescore with it — a document walk, a colour and
        // a style string per cell, and a fresh DecorationSet over the whole array. It ran
        // unconditionally, on every transaction, including the many that cannot change what a
        // decoration shows. Only the inputs below can.
        const stale = tr.docChanged
          || tr.selectionSet
          || value.cells !== before.cells
          || value.showFeedback !== before.showFeedback
          || value.focusedCell !== before.focusedCell
          || value.lastFocusedCell !== before.lastFocusedCell
          || !before.decorations;
        if (!stale) {
          // Positions are unchanged when the doc is, so this is a no-op mapping rather than a
          // rebuild — but it keeps the set correct if that ever stops being true.
          return { ...value, decorations: before.decorations.map(tr.mapping, tr.doc) };
        }
        const cellExprs = self.getState(state);
        const validation = formState.data?.validation || null;
        const decorations = applyModelRules(cellExprs, state, value, validation, formState);
        return {
          ...value,
          decorations,
        };
      }
    },
    props: {
      decorations(state) {
        return this.getState(state).decorations;
      },
      handleDOMEvents: {
        // A link cell's anchor. Link cells are display-only (getCell protects them), so a plain
        // click opens the link; a shift or cmd/ctrl click is a selection gesture and only selects.
        // Opened here rather than left to the browser: inside an editable document a click on an
        // anchor places the caret and goes nowhere.
        click(_view, event) {
          const anchor = (event.target as any)?.closest?.("a.gc-link");
          if (!anchor) return false;
          event.preventDefault();
          if (event.shiftKey || event.metaKey || event.ctrlKey) return true;
          const href = anchor.getAttribute("href");
          if (isWebAddress(href)) window.open(href, "_blank", "noopener,noreferrer");
          return true;
        },
        mousedown(view, event) {
          // Get the position in the document from the mouse event
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (!pos) return false;

          // Get the node at this position
          const $pos = view.state.doc.resolve(pos.pos);
          let cellNode = null;
          let cellName = null;

          // Find the table cell node
          for (let depth = $pos.depth; depth > 0; depth--) {
            const node = $pos.node(depth);
            if (node.type.name === "table_cell") {
              cellNode = node;
              cellName = node.attrs.name;
              break;
            }
          }

          if (cellNode && cellName) {
            const currentFocus = formState.data.focus;

            // Handle shift-click for cell range selection
            if (event.shiftKey && currentFocus) {
              let startCell = null;

              if (currentFocus.type === "cell") {
                if (currentFocus.isRange && currentFocus.cells && currentFocus.cells.length > 0) {
                  // Use the first cell of the range as the anchor
                  startCell = currentFocus.cells[0];
                } else if (currentFocus.name && !currentFocus.name.includes(',')) {
                  // Single cell selected
                  startCell = currentFocus.name;
                }
              }

              if (startCell) {
                const rangeCells = getCellRange(startCell, cellName);

                if (rangeCells.length > 0) {
                  formState.apply({
                    type: "focus",
                    args: {
                      type: "cell",
                      name: rangeCells.join(','),  // Send as comma-separated list
                      cells: rangeCells,  // Also include array for internal use
                      isRange: true,  // Flag to indicate this is a range
                    },
                  });

                  // Update decorations
                  const tr = view.state.tr;
                  tr.setMeta("focusChanged", true);
                  view.dispatch(tr);

                  event.preventDefault();
                  return true;
                }
              }
            }

            // If there's row/column/sheet highlighting or multi-cell selection and we click on ANY cell (focused or not),
            // we should clear the highlighting
            if (currentFocus && (currentFocus.type === "row" || currentFocus.type === "column" || currentFocus.type === "sheet" ||
                (currentFocus.type === "cell" && currentFocus.isRange))) {
              // Check if this cell is in the highlighted area
              const cellColumn = cellName.match(/^([A-Z]+)/)?.[1];
              const cellRow = cellName.match(/(\d+)$/)?.[1];

              let isInHighlightedArea = false;
              if (currentFocus.type === "sheet") {
                // Any data cell click clears sheet focus
                isInHighlightedArea = true;
              } else if (currentFocus.type === "column") {
                // Clicking any cell in any of the highlighted columns
                const selectedColumns = currentFocus?.columns || (currentFocus?.name ? [currentFocus?.name] : []);
                if (cellColumn === currentFocus?.name || selectedColumns.includes(cellColumn)) {
                  isInHighlightedArea = true;
                }
              } else if (currentFocus.type === "row") {
                // Clicking any cell in the highlighted rows
                const selectedRows = currentFocus?.rows || (currentFocus?.name ? [currentFocus?.name] : []);
                if (cellRow === currentFocus?.name || selectedRows.includes(cellRow)) {
                  isInHighlightedArea = true;
                }
              } else if (currentFocus.type === "cell" && currentFocus.isRange && currentFocus.cells) {
                // Clicking any cell in the highlighted range
                if (currentFocus.cells.includes(cellName)) {
                  isInHighlightedArea = true;
                }
              }

              // If we're clicking on any cell in the highlighted area, clear the highlight
              if (isInHighlightedArea) {
                formState.apply({
                  type: "focus",
                  args: {
                    type: "cell",
                    name: cellName,
                  },
                });
                // Force a re-render by dispatching an empty transaction
                const tr = view.state.tr;
                tr.setMeta("focusCleared", true);
                view.dispatch(tr);
              }
            }
          }
          return false; // Allow normal event processing
        }
      }
    }
  });
  return self;
}

// The row-heading column's width. When headings are hidden it is 1px, not 0: prosemirror-tables
// reads a 0 as "no width" and adds its default minimum to the table's inline width instead. The
// heading cells and this column's <col> are then hidden by `.gc-hide-headings` in Form.css; they
// stay in the document so every cell keeps its real name and the header-aware navigation, which
// indexes row 0 and the `_` column as headings, is unchanged.
const headingWidth = hideHeadings => [hideHeadings ? 1 : 40];

const buildCell = ({ col, row, attrs, colsAttrs, hideHeadings }) => {
  colsAttrs = colsAttrs || {};
  const cell = row[col];
  const colspan = cell?.attrs?.colspan || 1;
  const rowspan = cell?.attrs?.rowspan || 1;
  // One width per column the cell covers, as prosemirror-tables expects of a spanning cell (0 is
  // "no width"); null when none of them has one.
  const spanned = col === "_" ? [] : Array.from({ length: colspan }, (_, i) =>
    colsAttrs[String.fromCharCode(col.charCodeAt(0) + i)]?.width || 0);
  const colwidth = col === "_" && headingWidth(hideHeadings) ||
    (spanned.some(w => w) ? spanned : null);
  // Check cell's own background-color first (from attrs), then column's, then row's
  const background = cell?.attrs?.['background-color'] ||
                   colsAttrs[col]?.['background-color'] ||
                   attrs?.['background-color'];

  const { text } = cell || {};
  const textContent = text ? [
    {
      "type": "text",
      text: String(text),
    }
  ] : [];
  const content = [
    {
      "type": "paragraph",
      "content": textContent
    }
  ];
  const isHeader = cell.type === "th";

  // Calculate dynamic height based on font size if present (but not for headers)
  let cellHeight = "auto"; // Default to auto height
  const fontSize = attrs?.['font-size'] || colsAttrs[col]?.['font-size'] || cell?.['font-size'];
  if (fontSize && !isHeader) {
    // Extract numeric value from font size
    const sizeMatch = fontSize.match(/(\d+(?:\.\d+)?)/);
    if (sizeMatch) {
      const size = parseFloat(sizeMatch[1]);
      // Add minimal padding to font size for compact row height
      // Using 1.2x for tighter spacing (was 1.5x)
      cellHeight = `${Math.max(size * 1.2 + 4, 24)}px`; // size * 1.2 + 4px padding
    }
  }

  // Filter out font-size for header cells
  // Ensure we have valid objects to spread (handle undefined)
  const filteredAttrs = isHeader ? { ...(attrs || {}) } : (attrs || {});

  // Filter out background-color from column attrs as it's handled separately
  const { 'background-color': _colBg, ...restColsAttrs } = colsAttrs[col] || {};
  const filteredColsAttrs = isHeader ? { ...restColsAttrs } : restColsAttrs;

  // Extract only the attributes from the cell, excluding text and type
  const { text: _text, type: _type, attrs: cellAttrsObj, ...cellRest } = cell || {};
  // Filter out background properties from the cell's attrs since they're handled separately
  const { 'background-color': _cellBg, background: _cellBgProp, ...filteredCellAttrs } = cellAttrsObj || {};
  const filteredCell = isHeader ? { ...(cell || {}) } : { ...cellRest, ...filteredCellAttrs };


  if (isHeader) {
    // Remove font-size related properties from headers
    delete filteredAttrs?.['font-size'];
    delete filteredColsAttrs?.['font-size'];
    delete filteredCell?.['font-size'];

    // Remove border properties from headers to prevent row/column borders from appearing on labels
    delete filteredAttrs?.border;
    delete filteredColsAttrs?.border;
  }

  const result = {
    "type": isHeader && "table_header" || "table_cell",
    "attrs": {
      name: `${col}${row._.text || 0}`,
      colspan,
      rowspan,
      colwidth,
      height: cellHeight,
      background,
      // Set readonly attribute for header cells
      readonly: isHeader ? "true" : null,
      ...filteredAttrs,  // Spread filtered row attributes
      ...filteredColsAttrs,  // Column attributes override row attributes
      ...filteredCell,  // Cell attributes override everything
    },
    "content": content,
  };


  return result;
};

// A covered address gets no node: its anchor's colspan/rowspan already fills the position, and a
// node there too would be an overfull row that `fixTables` "repairs" by mangling the table.
const buildRow = ({ cols, row, rowIndex, attrs, colsAttrs, hideHeadings, covered }) => {
  return ({
    "type": "table_row",
    "content": cols
      .filter(col => !covered?.has(`${col}${rowIndex}`))
      .map(col => buildCell({col, row, attrs, colsAttrs, hideHeadings})),
  })
};

const buildTable = ({ cols, rows, attrs, colsAttrs, hideHeadings, covered }) => {
  return ({
    "type": "table",
    "content": rows.map((row, rowIndex) => {
      return buildRow({cols, row, rowIndex, colsAttrs, attrs: attrs[rowIndex], hideHeadings, covered});
    })
  })
};

const buildDocFromTable = ({ cols, rows, colsAttrs, rowsAttrs, hideHeadings, covered }) => {
  const attrs = applyRules({ rows, rowsAttrs });
  return {
    "type": "doc",
    "content": [
      {
        ...buildTable({cols, rows, attrs, colsAttrs, hideHeadings, covered}),
      },
    ]
  }
};

// Despite the name, this only lifts row attributes into a per-row-index array; it used to also
// sum each row into a `total` that was never read.
const applyRules = ({ rows, rowsAttrs }) => {
  const rowAttrs = []
  rows.forEach((row, rowIndex) => {
    if (rowAttrs[rowIndex] === undefined) {
      rowAttrs[rowIndex] = {};
    }
    // Merge row attributes from rowsAttrs if available
    // rowIndex 0 is the header row (column labels)
    // rowIndex 1 is the first data row (labeled as row 1 in the spreadsheet)
    // rowIndex 2 is the second data row (labeled as row 2 in the spreadsheet)
    // rowsAttrs uses spreadsheet row numbers (1, 2, 3...) as keys
    if (rowsAttrs && rowsAttrs[rowIndex]) {
      rowAttrs[rowIndex] = { ...rowsAttrs[rowIndex] };
    }
    // Don't set a default background color - let cells use their natural background
  });
  return rowAttrs;
};

// `sheetProtected` is `protected` on the sheet: the default for every cell, beneath the cell's
// own, its column's and its row's (cell beats column beats row beats sheet), so a protected sheet
// can still leave a cell open with `protected false`.
const getCell = (row, col, cells, columns, rows, sheetProtected = undefined) => {
  if (row === 0 && col === "_") {
    return {
      type: "th",
      text: "",  // Empty text for top-left corner
      attrs: { readonly: "true" }
    };
  }
  if (col === "_" && row !== 0) {
    return {
      type: "th",
      text: row,
      attrs: { readonly: "true" }
    };
  }
  if (row === 0 && col !== "_") {
    return {
      type: "th",
      text: col,
      attrs: { readonly: "true" }
    };
  }
  if (row !== 0 && col !== "_") {
    const cellKey = `${col}${row}`;
    const cellData = cells[cellKey] || {};
    const columnData = columns && columns[col] || {};
    const rowData = rows && rows[row] || {};
    // Extract text separately to ensure it's not lost in attribute merging
    const { text, ...cellAttrs } = cellData;

    // Extract borders to merge them specially
    const rowBorder = rowData?.border;
    const columnBorder = columnData?.border;
    const cellBorder = cellAttrs?.border || cellData.attrs?.border;

    // Merge borders from all sources
    const mergedBorder = mergeBorders(mergeBorders(rowBorder, columnBorder), cellBorder);

    // Merge other attributes with spread operator (cell data takes precedence)
    const { border: _rb, ...rowAttrsNoBorder } = rowData;
    const { border: _cb, ...columnAttrsNoBorder } = columnData;
    const { border: _cellb, ...cellAttrsNoBorder } = cellAttrs;
    const { border: _cellAttrsb, ...cellDataAttrsNoBorder } = cellData.attrs || {};

    const mergedAttrs = {
      ...rowAttrsNoBorder,
      ...columnAttrsNoBorder,
      ...cellAttrsNoBorder,
      ...cellDataAttrsNoBorder,
      ...(mergedBorder ? { border: mergedBorder } : {})
    };


    return {
      type: "td",
      // A link with no label shows its address.
      text: text || (isWebAddress(mergedAttrs?.link) ? mergedAttrs.link : ""),
      attrs: {
        // Extract attributes from merged attrs structure for ProseMirror
        underline: mergedAttrs?.underline,
        border: mergedAttrs?.border,
        'font-weight': mergedAttrs?.['font-weight'],
        'font-size': mergedAttrs?.['font-size'],
        'font-family': mergedAttrs?.['font-family'],
        'font-style': mergedAttrs?.['font-style'],
        color: mergedAttrs?.color,
        'text-decoration': mergedAttrs?.['text-decoration'],
        'vertical-align': mergedAttrs?.['vertical-align'],
        background: mergedAttrs?.background,
        'background-color': mergedAttrs?.['background-color'],
        align: mergedAttrs?.align || mergedAttrs?.justify,
        format: mergedAttrs?.format,
        assess: mergedAttrs?.assess,
        // A link cell is display-only: it is something to click, not to type into, and keeping
        // the caret out of it is what lets a plain click open the link.
        protected: (mergedAttrs?.protected ?? sheetProtected) ||
          (isWebAddress(mergedAttrs?.link) ? true : undefined),
        // Read by buildCell: it builds the node's spans from these. Without them here the spans
        // never reach the document — prosemirror-tables declares the attributes, but only the
        // model has the values.
        colspan: mergedAttrs?.colspan,
        rowspan: mergedAttrs?.rowspan,
        link: isWebAddress(mergedAttrs?.link) ? mergedAttrs.link : undefined,
        wrap: mergedAttrs?.wrap,
      },
    };
  }
  return {};
};

export const makeEditorState = ({ type, columns, cells, rows, hideHeadings, sheetProtected }: any) => {
  if (!cells || Object.keys(cells).length === 0) {
    return null;
  }
  // The grid reaches the far corner of every merge, not just of every named cell: an A1:F1 title
  // over a single A1 needs columns through F. (Max col count is 26; the compiler enforces it.)
  const { x, y } = gridExtent(cells);
  const { covered } = spansOf(cells);
  switch (type) {
  case "table": {
    const cols = Array.apply(null, Array(x + 1)).map((_, col) => letters[col])
    const rowsData = Array.apply(null, Array(y + 1)).map((_, row) =>
      cols.reduce((rowAccum, col) =>
        ({
          ...rowAccum,
          [col]: getCell(row, col, cells || {}, columns, rows, sheetProtected)
        }), {}
      )
    );
    const doc = buildDocFromTable({
      cols,
      rows: rowsData,
      colsAttrs: columns,
      rowsAttrs: rows,
      hideHeadings,
      covered,
    });
    return {
      doc: doc,
      selection: {
        type: "text",
        anchor: 1,
        head: 1,
      },
    };
  }
  default:
    return null;
  }
};

/**
 * `freeze-rows` / `freeze-columns`: measures the frozen rows' heights and columns' widths and
 * publishes the running offsets as CSS variables on the editor's container, where the sticky
 * decorations (stickyStyle) read them. Measured after every update, since wrapping text changes a
 * row's height; `offsetHeight` / `offsetWidth` ignore the sticky shift, so scrolling does not
 * feed back into the measurement.
 */
const makeFreezePlugin = (freezeRows, freezeColumns) => new Plugin({
  view(editorView) {
    const measure = () => {
      const host = editorView.dom.parentElement;
      const tableEl = editorView.dom.querySelector("table");
      if (!host || !tableEl) return;
      let tableNode = null;
      let tableStart = 0;
      editorView.state.doc.descendants((node, pos) => {
        if (tableNode) return false;
        if (node.type.name === "table") {
          tableNode = node;
          tableStart = pos + 1;
          return false;
        }
        return true;
      });
      if (!tableNode) return;
      const map = TableMap.get(tableNode);
      let top = 0;
      for (let r = 0; r <= freezeRows && r < map.height; r++) {
        host.style.setProperty(`--gc-top-${r}`, `${top}px`);
        top += (tableEl.rows[r] as HTMLElement)?.offsetHeight || 0;
      }
      let left = 0;
      for (let c = 0; c <= freezeColumns && c < map.width; c++) {
        host.style.setProperty(`--gc-left-${c}`, `${left}px`);
        // A column's width, from any cell that occupies it alone.
        let width = 0;
        for (let r = 0; r < map.height; r++) {
          const offset = map.map[r * map.width + c];
          const rect = map.findCell(offset);
          if (rect.left !== c || rect.right !== c + 1) continue;
          width = (editorView.nodeDOM(tableStart + offset) as HTMLElement)?.offsetWidth || 0;
          break;
        }
        left += width;
      }
    };
    measure();
    window.addEventListener("resize", measure);
    return {
      update: measure,
      destroy() {
        window.removeEventListener("resize", measure);
      },
    };
  },
});

export const TableEditor = ({ state, onEditorViewChange = undefined }: any) => {
  const { type, columns, cells, rows, hideHeadings } = state.data.interaction;
  // `protected` on the sheet: every cell protected, through the same machinery as a protected cell.
  const sheetProtected = state.data.interaction.protected === true ? true : undefined;
  const freezeRows = Number(state.data.interaction.freezeRows) || 0;
  const freezeColumns = Number(state.data.interaction.freezeColumns) || 0;
  const frozen = freezeRows > 0 || freezeColumns > 0;
  const [ editorView, setEditorView ] = useState(null);
  const [ tooltipState, setTooltipState ] = useState({ visible: false, x: 0, y: 0 });
  const tooltipHandler = {
    showTooltip: (event) => {
      // Try to get position from mouse event or element
      let x: number, y: number;
      if (event.clientX && event.clientY) {
        // Mouse event with coordinates
        x = event.clientX;
        y = event.clientY;
      } else {
        // Fallback to element bounds
        const rect = event.target?.getBoundingClientRect?.() || { left: 0, top: 0, width: 0 };
        x = rect.left + (rect.width / 2);
        y = rect.top;
      }
      setTooltipState({
        visible: true,
        x,
        y,
      });
      // Auto-hide tooltip after 4 seconds
      setTimeout(() => {
        setTooltipState(prev => ({ ...prev, visible: false }));
      }, 4000);
    }
  };
  const cellPlugin = buildCellPlugin(state);
  const menuPlugin = buildMenuPlugin(state);
  const plugins = [
    // columnResizing() is NOT optional, and is not only a drag affordance: it renders the
    // <colgroup>/<col> elements that carry `colwidth`. Removing it drops every authored column
    // width — measured, a 150px column became 462px and the table stretched to fill its container.
    //
    // The dragging it also enables is a separate problem: a resized width reaches no action, so it
    // never gets into the model or the response and is discarded on the next re-seed. The handle
    // is hidden in Form.css instead, which removes the affordance and keeps the rendering.
    columnResizing(),
    tableEditing(),
    history(),
    keymap({"Mod-z": undo, "Mod-y": redo}),
    keymap({
      ...baseKeymap,
      Tab: skipHeadersGoToNextCell(1),
      'Shift-Tab': skipHeadersGoToNextCell(-1),
      Enter: skipHeadersGoToNextCell(1),
      // Use simpler arrow handlers - let the plugin's keydown handler do the header prevention
    }),
    menuPlugin,
    //  modelBackgroundPlugin(),
    makeTableHeadersReadOnlyPlugin(state),
    makeProtectedCellsPlugin(tooltipHandler),
    ...(frozen ? [makeFreezePlugin(freezeRows, freezeColumns)] : []),
    cellPlugin,
  ];
  const editorRef = useRef(null);
  useEffect(() => {
    if (!editorRef.current) {
      return;
    }
    // Create initial state with data if available
    let initEditorState;
    if (cells && Object.keys(cells).length > 0) {
      const editorStateData = makeEditorState({type, columns, cells, rows, hideHeadings, sheetProtected});
      if (editorStateData) {
        initEditorState = EditorState.fromJSON({
          schema,
          plugins,
        }, editorStateData);
      } else {
        initEditorState = EditorState.create({
          schema,
          plugins,
        });
      }
    } else {
      initEditorState = EditorState.create({
        schema,
        plugins,
      });
    }
    const fix = fixTables(initEditorState);
    if (fix) initEditorState = initEditorState.apply(fix.setMeta('addToHistory', false));
    const editorView = new EditorView(editorRef.current, {
      state: initEditorState,
      dispatchTransaction(transaction) {
        const editorState = editorView.state.apply(transaction);
        editorView.updateState(editorState);
        // debouncedStateUpdate({
        //   state,
        //   editorState: editorState.toJSON()
        // });
      },
    });
    setEditorView(editorView);
    onEditorViewChange?.(editorView);
    return () => {
      if (editorView) {
        editorView.destroy();
      }
    };
  }, []);
  // Feedback visibility reaches the plugins only this way: they hold the `state` they were built
  // with. A check lays `showValidationUI` over the model without touching `interaction.cells`, so
  // it re-renders this without re-seeding the document (which would throw the caret to A1).
  const showFeedback = showsFeedback(state.data);
  useEffect(() => {
    if (!editorView) return;
    editorView.dispatch(
      editorView.state.tr.setMeta("feedback", showFeedback).setMeta("addToHistory", false));
  }, [editorView, showFeedback]);
  // const templateVariablesRecords = state.data.templateVariablesRecords || [];
  // const index = Math.floor(Math.random() * templateVariablesRecords.length);
  // const env = templateVariablesRecords[index];
  useEffect(() => {
    if (editorView && cells) {
      const editorStateData = makeEditorState({type, columns, cells, rows, hideHeadings, sheetProtected});
      if (!editorStateData) {
        // If no editor state data, create an empty state
        const newEditorState = EditorState.create({
          schema,
          plugins,
        });
        editorView.updateState(newEditorState);
        return;
      }
      const newEditorState = EditorState.fromJSON({
        schema,
        plugins,
      }, editorStateData);
      editorView.updateState(newEditorState);
      const { pos } = getCellNodeByName({state: newEditorState, name: "A1"});
      if (!pos) return;
      const resolvedPos = newEditorState.doc.resolve(pos + 1); // +1 to position cursor inside the cell
      editorView.dispatch(editorView.state.tr.setSelection(new TextSelection(resolvedPos)));
      // editorView.focus();
    }
  }, [editorView, columns, cells]);
  return (
    <>
      <div
        ref={editorRef}
        className={`border border-gray-300 p-2 bg-white text-xs font-sans${hideHeadings ? " gc-hide-headings" : ""}${frozen ? " gc-frozen" : ""}`}
      />
      <ProtectedCellTooltip
        visible={tooltipState.visible}
        x={tooltipState.x}
        y={tooltipState.y}
      />
    </>
  );
};
