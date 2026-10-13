// SPDX-License-Identifier: MIT
/**
 * Dispatch on the interaction type. L0179 emits exactly one — `"table"` — because
 * `Transformer.PROG` hard-codes it; anything else is a malformed model, so it draws nothing
 * rather than guessing.
 *
 * Two things were dropped when this was adopted from L0166, both deliberate:
 *
 *   - the `"text"` branch and its `TextEditor`, which L0179 can never reach;
 *   - a SECOND `<MenuView className="hidden">` rendered here alongside the one `buildMenuPlugin`
 *     mounts imperatively above the grid. Two formula bars were rendered and one was hidden by a
 *     rule in the stylesheet rather than by markup, so the layout depended on a CSS import to not
 *     look broken. The plugin-mounted one is the real one; this one only ever set `selected` on a
 *     module-level array that the visible instance sets again on every update.
 */
import React from "react"; React;
import { TableEditor } from "./TableEditor";

export const Editor = ({ state }) => (
  state.data.interaction?.type === "table"
    ? <TableEditor state={state} />
    : <div />
);
