// SPDX-License-Identifier: MIT
import React from "react"; React;
import { FormulaBar } from "./FormulaBar";

function classNames(...classes) {
  const className = classes.filter(Boolean).join(' ')
  return className;
}

/**
 * The bar above the grid. It holds the formula input and nothing else.
 *
 * It used to also track whether bold/italic marks were active on the selection, for two buttons
 * that have been commented out since L0166. The language has no inline marks — emphasis is a cell
 * attribute — so the schema no longer declares any, and that tracking would now throw on an
 * undefined `schema.marks.strong`.
 */
export const MenuView = ({ className, editorView, hideMenu = false }) => {
  // Don't render anything if hideMenu is true
  if (hideMenu) {
    return null;
  }
  return (
    <div
      className={classNames(
        "flex flex-col gap-1 mb-2 text-sm font-sans pb-1 border-b border-gray-200",
        className
      )}
    >
      {/*
      <div
        className={classNames(
          "flex flex-row gap-1 mb-2 text-sm font-sans"
        )}
      >
        {
          items.map(item => (
            <button
              key={item.name}
              className={classNames(
                "w-7 h-7 text-center border border-1 rounded",
                item.selected && "bg-gray-100",
                item.className
              )}
              onMouseDown={
                e => {
                  e.preventDefault();
                  editorView.focus();
                  toggle(item);
                }
              }>
              {
                item.name
              }
            </button>
          ))
        }
        </div>
       */}
      <FormulaBar
        editorView={editorView}
      />
    </div>
  );
};
