// SPDX-License-Identifier: MIT
/**
 * Who owns a pointer that goes down: a drag, or the browser (a tap, or a scroll). Pure.
 *
 * Trays and the diagram frame scroll, so on a touch screen a swipe must be able to scroll them.
 * The browser decides whether a touch scrolls from `touch-action` when the touch STARTS, and a
 * later `preventDefault` need not be honoured — so ownership is decided by where the touch
 * starts, never by how long it is held:
 *
 * - a tray item's grip handle (`touch-action: none`) drags, with any pointer;
 * - a tray item's body (`touch-action: pan-x pan-y`) scrolls the tray under a finger and is tapped
 *   to select; a mouse or pen still drags it;
 * - a filled blank on the web (`touch-action: none`) drags. The web scrolls from its empty space.
 */

export type DragRole = "handle" | "tray-body" | "blank";

export function startsDrag(pointerType: string, role: DragRole): boolean {
  return role === "tray-body" ? pointerType !== "touch" : true;
}
