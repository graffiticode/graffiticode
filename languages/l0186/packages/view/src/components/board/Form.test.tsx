// SPDX-License-Identifier: MIT
// The Form: errors, the SVG preview (and nothing else — no FigJam frame), and the page tabs,
// which show for two or more pages and never for one.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Board, Form, type BoardData } from "./Form";

afterEach(cleanup);

const page = (name: string, nodes: any[] = [{ type: "sticky", text: name }]) => ({ name, nodes });
const board = (pages: ReturnType<typeof page>[], over: Partial<BoardData> = {}): BoardData => ({
  type: "board",
  showPageTabs: pages.length > 1,
  showPageMenu: false,
  pages,
  ...over,
});

describe("Form", () => {
  it("shows compile errors", () => {
    render(<Form state={{ data: {}, errors: [{ message: "page: boom" }] } as any} />);
    expect(screen.getByRole("alert").textContent).toContain("page: boom");
  });

  it("draws the board as SVG, and never embeds FigJam", () => {
    const { container } = render(
      <Form
        state={
          {
            data: board([
              page("Page 1", [
                { type: "sticky", id: "a", text: "Hello" },
                { type: "shape", shapeType: "DIAMOND", text: "Go?", x: 300 },
                { type: "stamp", stamp: "like", x: 600 },
                { type: "section", name: "S", x: 0, y: 400, nodes: [{ type: "text", text: "inside" }] },
                { type: "connector", from: "a", to: "Go?", label: "next" },
              ]),
            ], { fileKey: "ABC123" } as any),
            errors: [],
          } as any
        }
      />,
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("img").tagName.toLowerCase()).toBe("svg");
    const kinds = [...container.querySelectorAll("[data-node]")].map((n) => n.getAttribute("data-node"));
    expect(kinds).toEqual(["sticky", "shape", "stamp", "section", "text", "connector"]);
    expect(container.querySelector('[data-shape="DIAMOND"]')).toBeTruthy();
    expect(container.textContent).toContain("Hello");
    expect(container.textContent).toContain("next");
  });

  it("renders nothing for data that is not a board", () => {
    const { container } = render(<Form state={{ data: { type: "charts" }, errors: [] } as any} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("pages", () => {
  it("show no tabs and no menu for a single page", () => {
    render(<Board data={board([page("Only")])} />);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("button", { name: "All pages" })).toBeNull();
  });

  it("show a tab per page, following the WAI-ARIA tabs pattern", () => {
    render(<Board data={board([page("Planning"), page("Retro")])} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Planning", "Retro"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    const panel = document.getElementById(tabs[0].getAttribute("aria-controls")!)!;
    expect(panel.getAttribute("role")).toBe("tabpanel");
    expect(screen.getByRole("tablist").getAttribute("aria-label")).toBe("Pages");
  });

  it("switch pages with a click or the arrow keys, drawing a page when first shown", () => {
    const { container } = render(<Board data={board([page("One"), page("Two")])} />);
    expect(container.querySelectorAll("svg[role=img]")).toHaveLength(1);
    fireEvent.click(screen.getAllByRole("tab")[1]);
    expect(screen.getAllByRole("tab")[1].getAttribute("aria-selected")).toBe("true");
    expect(container.querySelectorAll("svg[role=img]")).toHaveLength(2);
    fireEvent.keyDown(screen.getAllByRole("tab")[1], { key: "ArrowRight" });
    expect(screen.getAllByRole("tab")[0].getAttribute("aria-selected")).toBe("true");
  });

  it("keep the selected page by name across a recompile", () => {
    const { rerender } = render(<Board data={board([page("One"), page("Two")])} />);
    fireEvent.click(screen.getAllByRole("tab")[1]);
    rerender(<Board data={board([page("Zero"), page("One"), page("Two")])} />);
    expect(screen.getAllByRole("tab")[2].getAttribute("aria-selected")).toBe("true");
  });

  it("offer the page menu when asked, with the tabs hidden", () => {
    render(<Board data={board([page("One"), page("Two")], { showPageTabs: false, showPageMenu: true })} />);
    expect(screen.queryByRole("tablist")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All pages" }));
    expect(screen.getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual(["One", "Two"]);
  });
});
