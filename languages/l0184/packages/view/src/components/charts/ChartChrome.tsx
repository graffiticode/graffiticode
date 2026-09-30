// SPDX-License-Identifier: MIT
/**
 * The bar below the chart: a chart menu and a tab strip, arranged as L0179 arranges its sheets
 * (menu at the left, tabs to its right) and governed by the same two rules the compiler encodes:
 * the menu shows even for one chart unless `hide-chart-menu true`; tabs show with two or more
 * charts unless `show-chart-tabs` says otherwise.
 *
 * Accessibility is built here, not inherited from the markup:
 *
 * - TABS follow the WAI-ARIA tabs pattern: `tablist`/`tab`, `aria-selected`, `aria-controls`
 *   pointing at each chart's panel, and a roving tabindex, so Tab lands on the selected tab
 *   and the arrow keys, Home and End move between tabs, selecting as they go.
 * - The MENU is a button that opens a `menu` of `menuitemradio`s. Opening focuses the checked
 *   item; arrows, Home and End move; Enter or Space selects; Escape closes and returns focus to
 *   the button. It opens up or down into whichever has room — L0179's measurement, kept.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export interface ChartTab {
  id: string;
  name: string;
}

export const tabId = (base: string, id: string) => `${base}-tab-${id}`;
export const panelId = (base: string, id: string) => `${base}-panel-${id}`;

const MenuIcon = () => (
  <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true" focusable="false">
    <rect x="2" y="4" width="14" height="1.6" fill="currentColor" />
    <rect x="2" y="8.2" width="14" height="1.6" fill="currentColor" />
    <rect x="2" y="12.4" width="14" height="1.6" fill="currentColor" />
  </svg>
);

/** The index a navigation key moves to, or null for any other key. */
function step(key: string, i: number, n: number, back: string, forward: string): number | null {
  if (key === forward) return (i + 1) % n;
  if (key === back) return (i - 1 + n) % n;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return null;
}

export const ChartChrome = ({
  base,
  charts,
  activeId,
  onSelect,
  showMenu,
  showTabs,
}: {
  base: string;
  charts: ChartTab[];
  activeId: string;
  onSelect: (id: string) => void;
  showMenu: boolean;
  showTabs: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{ up: boolean; maxHeight: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = Math.max(0, charts.findIndex((c) => c.id === activeId));

  /** Open into whichever of above and below has more room, capped at that room. */
  const place = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const GAP = 8;
    const above = rect.top - GAP;
    const below = window.innerHeight - rect.bottom - GAP;
    const up = above >= below;
    setPlacement({ up, maxHeight: Math.max(72, Math.min(256, up ? above : below)) });
  };

  useEffect(() => {
    if (!open) return;
    itemRefs.current[active]?.focus();
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onViewport = () => place();
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onViewport);
    window.addEventListener("scroll", onViewport, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onViewport);
      window.removeEventListener("scroll", onViewport, true);
    };
  }, [open]);

  if (!showMenu && !showTabs) return null;

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  const pick = (id: string) => {
    onSelect(id);
    close();
  };

  const onMenuKey = (e: KeyboardEvent, i: number) => {
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(charts[i].id);
      return;
    }
    const to = step(e.key, i, charts.length, "ArrowUp", "ArrowDown");
    if (to !== null) {
      e.preventDefault();
      itemRefs.current[to]?.focus();
    }
  };

  const onTabKey = (e: KeyboardEvent, i: number) => {
    const to = step(e.key, i, charts.length, "ArrowLeft", "ArrowRight");
    if (to === null) return;
    e.preventDefault();
    onSelect(charts[to].id);
    tabRefs.current[to]?.focus();
  };

  return (
    <div className="l0184-chrome" role="group" aria-label="Charts">
      {showMenu && (
        <div className="l0184-menu" ref={menuRef}>
          <button
            ref={buttonRef}
            type="button"
            className="l0184-menu-button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={`${base}-menu`}
            aria-label="All charts"
            title="All charts"
            onClick={() => {
              if (!open) place();
              setOpen((v) => !v);
            }}
          >
            <MenuIcon />
          </button>
          {open && (
            <ul
              id={`${base}-menu`}
              className="l0184-menu-list"
              role="menu"
              aria-label="All charts"
              style={
                placement
                  ? {
                      maxHeight: placement.maxHeight,
                      ...(placement.up ? { bottom: "2.25rem", top: "auto" } : { top: "2.25rem", bottom: "auto" }),
                    }
                  : undefined
              }
            >
              {charts.map((c, i) => (
                <li key={c.id} role="none">
                  <button
                    ref={(n) => {
                      itemRefs.current[i] = n;
                    }}
                    type="button"
                    role="menuitemradio"
                    aria-checked={c.id === activeId}
                    tabIndex={-1}
                    className={`l0184-menu-item${c.id === activeId ? " is-active" : ""}`}
                    onClick={() => pick(c.id)}
                    onKeyDown={(e) => onMenuKey(e, i)}
                  >
                    {c.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {showTabs && (
        <div className="l0184-tabs" role="tablist" aria-label="Charts">
          {charts.map((c, i) => (
            <button
              key={c.id}
              ref={(n) => {
                tabRefs.current[i] = n;
              }}
              id={tabId(base, c.id)}
              type="button"
              role="tab"
              aria-selected={c.id === activeId}
              aria-controls={panelId(base, c.id)}
              tabIndex={c.id === activeId ? 0 : -1}
              className={`l0184-tab${c.id === activeId ? " is-active" : ""}`}
              onClick={() => onSelect(c.id)}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
