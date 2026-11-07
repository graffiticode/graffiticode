// SPDX-License-Identifier: MIT
import React from "react"; React;
import { useEffect, useState } from "react";

const updateTextNode = ({ editorView, from, text }) => {
  console.log(
    "updateTextNode()",
    "text=" + text,
  );

  const { doc, tr } = editorView.state;
  const resolvedPos = doc.resolve(from);
  const start = resolvedPos.start(resolvedPos.depth)
  const end = resolvedPos.end(resolvedPos.depth);
  const transaction = (
    text.length > 0 &&
      tr.replaceWith(start, end, editorView.state.schema.text(text)) ||
      tr.delete(start, end)
  );
  editorView.dispatch(transaction);
}

/** Whether the selection is in a protected cell, whose edits the grid refuses. */
const inProtectedCell = (state) => {
  const $from = state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === "table_cell") return node.attrs.protected === true;
  }
  return false;
};

export const FormulaBar = ({ editorView }) => {
  const [ value, setValue ] = useState("");
  // A protected cell's formula is shown but not editable here: the grid refuses the edit, and an
  // editable bar would show typing the cell never takes.
  const [ readOnly, setReadOnly ] = useState(false);
  const updateFormulaBar = () => {
    if (editorView?.state) {
      const { from } = editorView.state.selection;
      const pos = editorView.state.doc.resolve(from);
      const node = editorView.state.doc.nodeAt(pos.pos - 1);
      const newValue = node?.textContent || "";
      setValue(newValue);
      setReadOnly(inProtectedCell(editorView.state));
    }
  };

  useEffect(() => {
    if (!editorView) return;
    // Initial update
    updateFormulaBar();
    // Add event listeners to detect selection changes
    const handleSelectionChange = () => {
      updateFormulaBar();
    };
    const handleKeyDown = () => {
      // Use setTimeout to let the selection update first
      setTimeout(updateFormulaBar, 0);
    };
    const handleClick = () => {
      // Use setTimeout to let the selection update first
      setTimeout(updateFormulaBar, 0);
    };
    if (editorView.dom) {
      editorView.dom.addEventListener('keydown', handleKeyDown);
      editorView.dom.addEventListener('click', handleClick);
      document.addEventListener('selectionchange', handleSelectionChange);
    }
    return () => {
      if (editorView.dom) {
        editorView.dom.removeEventListener('keydown', handleKeyDown);
        editorView.dom.removeEventListener('click', handleClick);
        document.removeEventListener('selectionchange', handleSelectionChange);
      }
    };
  }, [editorView]);
  const handleChange = value => {
    setValue(value);
    const { from } = editorView.state.selection;
    updateTextNode({editorView, from, text: value});
  };
  return (
    <div className="flex flex-row gap-2 rounded-md">
      <label className="block text-md font-medium font-serif italic text-gray-500 mb-0">
        fx
      </label>
      <input
        id="formula"
        name="formula"
        type="text"
        value={value}
        readOnly={readOnly}
        // `outline: none`, not `focus:outline-0`: that only zeroes the width, and Chrome still draws
        // its `auto` focus-visible ring at width 0 — the blue box a click on the bar used to show.
        style={{borderStyle: "none", outline: "none"}}
        onChange={e => handleChange(e.target.value)}
        className="block w-full ring-0 border-0 p-0 text-gray-900 placeholder:text-gray-400 sm:text-sm/6 focus:outline-0 focus:ring-0 border-none p-0 mb-0"
      />
    </div>
  )
}
