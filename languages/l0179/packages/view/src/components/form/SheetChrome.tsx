// SPDX-License-Identifier: MIT
/**
 * The bar below the grid: a sheet menu, and a tab strip.
 *
 * Arranged the way a spreadsheet arranges it — menu button at the left, tabs to its right — and
 * governed by two rules the compiler encodes:
 *
 *   - the MENU shows by default even for a single sheet, which is what makes an authored `name`
 *     visible in the common case. `hide-sheet-menu true` removes it.
 *   - the TABS show once there are two or more sheets. `show-sheet-tabs` overrides either way,
 *     so a lone sheet can have a tab and several sheets can have none.
 *
 * A lone unnamed sheet therefore gets a menu button and nothing else, which is as close to the
 * pre-sheets rendering as the feature allows.
 */
import React from "react"; React;
import { useEffect, useRef, useState } from "react";

export interface SheetTab {
  id: string;
  name: string;
}

/** Google Sheets' "all sheets" control: three stacked bars. */
const MenuIcon = () => (
  <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true" focusable="false">
    <rect x="2" y="4" width="14" height="1.6" fill="currentColor" />
    <rect x="2" y="8.2" width="14" height="1.6" fill="currentColor" />
    <rect x="2" y="12.4" width="14" height="1.6" fill="currentColor" />
  </svg>
);

export const SheetChrome = ({
  sheets,
  activeId,
  onSelect,
  showMenu,
  showTabs,
}: {
  sheets: SheetTab[];
  activeId: string;
  onSelect: (id: string) => void;
  showMenu: boolean;
  showTabs: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Where the list can actually fit, measured rather than assumed — see below.
  const [placement, setPlacement] = useState<{ up: boolean; maxHeight: number } | null>(null);

  /**
   * Size and place the list against the room really available.
   *
   * A fixed `max-height` opening upward is wrong whenever the sheet above is short: the list is
   * laid out from the button upwards, its top lands at a negative coordinate, and the entries up
   * there cannot be reached. Its own `overflow-y` does not save it — the list is not overflowing
   * ITSELF, it is hanging off the top of the viewport, and scrolling inside a box whose top edge
   * is off-screen moves nothing into view. A one-row sheet with twelve sheets showed four.
   *
   * So: measure the gap above and below the button, open into whichever is larger (preferring up,
   * which is where a spreadsheet puts it), and cap the height at that gap. Whatever is left over
   * then scrolls inside a list that is wholly on screen.
   */
  const place = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const GAP = 8;             // breathing room against the viewport edge
    const IDEAL = 256;         // what it would like, when there is room
    const above = rect.top - GAP;
    const below = window.innerHeight - rect.bottom - GAP;
    const up = above >= below;
    setPlacement({ up, maxHeight: Math.max(72, Math.min(IDEAL, up ? above : below)) });
  };

  // Close on an outside click or Escape. Without this the list stays open behind the grid and
  // swallows the next click the learner meant for a cell.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onViewport = () => place();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onViewport);
    window.addEventListener("scroll", onViewport, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onViewport);
      window.removeEventListener("scroll", onViewport, true);
    };
  }, [open]);

  if (!showMenu && !showTabs) return null;

  const pick = (id: string) => { onSelect(id); setOpen(false); };

  return (
    <div className="gc-sheet-chrome" role="group" aria-label="Sheets">
      {showMenu && (
        <div className="gc-sheet-menu" ref={menuRef}>
          <button
            ref={buttonRef}
            type="button"
            className="gc-sheet-menu-button"
            aria-haspopup="true"
            aria-expanded={open}
            aria-label="All sheets"
            title="All sheets"
            onClick={() => { if (!open) place(); setOpen((v) => !v); }}
          >
            <MenuIcon />
          </button>
          {open && (
            <ul
              className="gc-sheet-menu-list"
              role="menu"
              style={placement
                ? {
                    maxHeight: placement.maxHeight,
                    // Both edges, always: the stylesheet sets `bottom`, so opening downward
                    // without clearing it would anchor the list to top AND bottom and stretch it.
                    ...(placement.up
                      ? { bottom: "2.25rem", top: "auto" }
                      : { top: "2.25rem", bottom: "auto" }),
                  }
                : undefined}
            >
              {sheets.map((s) => (
                <li key={s.id} role="none">
                  <button
                    type="button"
                    role="menuitem"
                    className={`gc-sheet-menu-item${s.id === activeId ? " is-active" : ""}`}
                    onClick={() => pick(s.id)}
                  >
                    {s.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {showTabs && (
        <div className="gc-sheet-tabs" role="tablist">
          {sheets.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === activeId}
              className={`gc-sheet-tab${s.id === activeId ? " is-active" : ""}`}
              onClick={() => onSelect(s.id)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
