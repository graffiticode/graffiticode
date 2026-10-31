// SPDX-License-Identifier: MIT
// The Form paints compiled boards exactly as compiled: every board the Rust compiler produced for
// the test corpus (crates/core/tests/expected.json) renders one SVG group per node and connector,
// draws each mark's compiled lines, and pages are selected by id, so two pages may share a name.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import expected from "../../../../../crates/core/tests/expected.json";
import { Board, Form, type BoardData } from "./Form";
import { routePath } from "./BoardPreview";

afterEach(cleanup);

const compiled = Object.entries(expected as Record<string, any>)
  .filter(([, v]) => v.data)
  .map(([name, v]) => [name, v.data as BoardData] as const);

const count = (nodes: any[]): number =>
  nodes.reduce((n, node) => n + 1 + (node.type === "section" ? count(node.nodes) : 0), 0);

describe("Form", () => {
  it("shows compile errors", () => {
    render(<Form state={{ data: {}, errors: [{ message: "page: boom" }] } as any} />);
    expect(screen.getByRole("alert").textContent).toContain("page: boom");
  });

  it.each(compiled)("paints %s as compiled", (_name, data) => {
    const { container } = render(<Board data={data} />);
    const first = data.pages[0];
    const drawn = container.querySelectorAll("section:not([hidden]) [data-node]");
    expect(drawn.length).toBe(count(first.nodes));
    for (const node of first.nodes) {
      if (node.lines) {
        const g = container.querySelector(`[data-id="${node.id}"]`);
        expect(g?.querySelectorAll("tspan").length).toBe(node.lines.length);
      }
    }
  });

  it("selects pages by id, so pages may share a name", () => {
    const [, base] = compiled.find(([name]) => name === "retro")!;
    const data: BoardData = {
      ...base,
      showPageTabs: true,
      pages: [base.pages[0], { ...base.pages[0], id: "copy", nodes: base.pages[0].nodes.slice(0, 1) }],
    };
    render(<Board data={data} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBe(2);
    fireEvent.click(tabs[1]);
    const panels = document.querySelectorAll(".l0187-panel");
    expect((panels[0] as HTMLElement).hidden).toBe(true);
    expect((panels[1] as HTMLElement).hidden).toBe(false);
  });

  it("holds connector ends off their marks and rounds turns", () => {
    const { d, start, end } = routePath([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]);
    expect(start).toEqual({ x: 8, y: 0 });
    expect(end).toEqual({ x: 100, y: 92 });
    expect(d).toContain("Q100 0");
  });
});
