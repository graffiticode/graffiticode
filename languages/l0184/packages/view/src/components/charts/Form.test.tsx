// SPDX-License-Identifier: MIT
// Navigation and accessibility: tab roles and keys, the menu's keys and focus, panels kept
// mounted across tab switches, and selection kept by id across recompiles. jsdom reports every
// element as 0×0, so no ECharts instance is ever created here.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Charts, Form, type ChartsData } from "./Form";

afterEach(cleanup);

const chart = (id: string, name = id, empty = false) => ({
  id,
  name,
  option: { series: [{ type: "bar", data: [1] }] },
  view: { width: "100%", height: 300, empty, description: `${name} chart` },
});
const collection = (charts: ReturnType<typeof chart>[], over: Partial<ChartsData["view"]> = {}): ChartsData => ({
  type: "charts",
  charts,
  view: { theme: "light", renderer: "canvas", locale: "EN", showTabs: charts.length > 1, hideMenu: false, ...over },
});

describe("tabs", () => {
  it("follow the WAI-ARIA tabs pattern", () => {
    render(<Charts data={collection([chart("a", "Alpha"), chart("b", "Beta")])} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Alpha", "Beta"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].tabIndex).toBe(0);
    expect(tabs[1].tabIndex).toBe(-1);
    const panel = document.getElementById(tabs[0].getAttribute("aria-controls")!)!;
    expect(panel.getAttribute("role")).toBe("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0].id);
    expect(screen.getByRole("tablist").getAttribute("aria-label")).toBe("Charts");
  });

  it("move and select with the arrow keys, Home and End, taking focus", () => {
    render(<Charts data={collection([chart("a"), chart("b"), chart("c")])} />);
    const tabs = () => screen.getAllByRole("tab");
    fireEvent.keyDown(tabs()[0], { key: "ArrowRight" });
    expect(tabs()[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs()[1]);
    fireEvent.keyDown(tabs()[1], { key: "End" });
    expect(tabs()[2].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tabs()[2], { key: "ArrowRight" });
    expect(tabs()[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tabs()[0], { key: "ArrowLeft" });
    expect(tabs()[2].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tabs()[2], { key: "Home" });
    expect(document.activeElement).toBe(tabs()[0]);
  });

  it("show for one chart only when asked, and hide when asked", () => {
    render(<Charts data={collection([chart("a")])} />);
    expect(screen.queryByRole("tablist")).toBeNull();
    cleanup();
    render(<Charts data={collection([chart("a"), chart("b")], { showTabs: false })} />);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("button", { name: "All charts" })).toBeTruthy();
  });
});

describe("the chart menu", () => {
  it("opens on the checked chart, moves with arrows, selects with Enter and returns focus", () => {
    render(<Charts data={collection([chart("a", "Alpha"), chart("b", "Beta"), chart("c", "Gamma")])} />);
    const button = screen.getByRole("button", { name: "All charts" });
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitemradio");
    expect(document.activeElement).toBe(items[0]);
    expect(items[0].getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: "ArrowDown" });
    fireEvent.keyDown(items[2], { key: "Enter" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(screen.getAllByRole("tab")[2].getAttribute("aria-selected")).toBe("true");
  });

  it("closes with Escape without changing the chart", () => {
    render(<Charts data={collection([chart("a"), chart("b")])} />);
    const button = screen.getByRole("button", { name: "All charts" });
    fireEvent.click(button);
    fireEvent.keyDown(within(screen.getByRole("menu")).getAllByRole("menuitemradio")[0], { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(screen.getAllByRole("tab")[0].getAttribute("aria-selected")).toBe("true");
  });

  it("is hidden by hide-chart-menu", () => {
    render(<Charts data={collection([chart("a"), chart("b")], { hideMenu: true })} />);
    expect(screen.queryByRole("button", { name: "All charts" })).toBeNull();
  });
});

describe("panels", () => {
  it("mount a chart when first selected and keep it mounted, hidden, afterwards", () => {
    render(<Charts data={collection([chart("a"), chart("b")])} />);
    const panels = () => screen.getAllByRole("tabpanel", { hidden: true });
    expect(panels()[0].querySelector("[data-testid=echart]")).not.toBeNull();
    expect(panels()[1].querySelector("[data-testid=echart]")).toBeNull();
    fireEvent.click(screen.getAllByRole("tab")[1]);
    expect(panels()[1].querySelector("[data-testid=echart]")).not.toBeNull();
    expect(panels()[0].hidden).toBe(true);
    expect(panels()[0].querySelector("[data-testid=echart]")).not.toBeNull();
  });

  it("keep the selection by id across a recompile, and fall back to the first when it is gone", () => {
    const { rerender } = render(<Charts data={collection([chart("a"), chart("b")])} />);
    fireEvent.click(screen.getAllByRole("tab")[1]);
    rerender(<Charts data={collection([chart("a", "A2"), chart("b", "B2")])} />);
    expect(screen.getAllByRole("tab")[1].getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByRole("tab")[1].textContent).toBe("B2");
    rerender(<Charts data={collection([chart("a"), chart("c")])} />);
    expect(screen.getAllByRole("tab")[0].getAttribute("aria-selected")).toBe("true");
  });

  it("carry each chart's description for screen readers", () => {
    render(<Charts data={collection([chart("a", "Alpha")])} />);
    expect(screen.getByText("Alpha chart").className).toContain("sr-only");
  });

  it("say No data for an empty chart", () => {
    render(<Charts data={collection([chart("a", "a", true)])} />);
    expect(screen.getByText("No data")).toBeTruthy();
  });
});

describe("Form", () => {
  const apply = () => {};
  it("shows compile errors as an alert", () => {
    render(<Form state={{ data: null, errors: [{ message: "chart: needs a `plots`." } as any], apply }} />);
    expect(screen.getByRole("alert").textContent).toContain("needs a `plots`");
  });
  it("renders nothing for a model that is not a charts collection", () => {
    const { container } = render(<Form state={{ data: { type: "chart" }, errors: [], apply }} />);
    expect(container.textContent).toBe("");
  });
});
