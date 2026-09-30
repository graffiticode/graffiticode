// SPDX-License-Identifier: MIT
// When a chart instance is created, resized, replaced and disposed. ECharts is mocked — jsdom has
// no canvas — so these assert what the view asks of it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { EChart } from "./EChart";

let observers: { cb: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn> }[] = [];
let size = { w: 0, h: 0 };

beforeEach(() => {
  observers = [];
  size = { w: 0, h: 0 };
  (globalThis as any).ResizeObserver = class {
    cb: ResizeObserverCallback;
    disconnect = vi.fn();
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      observers.push(this as any);
    }
    observe() {}
    unobserve() {}
  };
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => size.w });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => size.h });
});
afterEach(cleanup);

const makeLib = () => {
  const instances: any[] = [];
  const lib: any = {
    init: vi.fn(() => {
      const inst = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
      instances.push(inst);
      return inst;
    }),
  };
  return { lib, instances };
};

const report = (w: number, h: number) =>
  act(() => {
    size = { w, h };
    for (const o of observers) o.cb([{ contentRect: { width: w, height: h } } as any], o as any);
  });

const base = { width: "100%", height: 384, theme: "light" as const, renderer: "canvas" as const, locale: "EN", active: true };

describe("EChart", () => {
  it("waits for a sized container before init, then inits with theme, renderer and locale", () => {
    const { lib, instances } = makeLib();
    render(<EChart {...base} theme="dark" renderer="svg" option={{ series: [] }} lib={lib} />);
    expect(lib.init).not.toHaveBeenCalled();
    report(400, 384);
    expect(lib.init).toHaveBeenCalledTimes(1);
    expect(lib.init.mock.calls[0][1]).toBe("dark");
    expect(lib.init.mock.calls[0][2]).toEqual({ renderer: "svg", locale: "EN" });
    expect(instances[0].setOption).toHaveBeenCalledWith({ series: [] }, { notMerge: true });
  });

  it("skips zero-size observer updates and resizes on real ones", () => {
    const { lib, instances } = makeLib();
    size = { w: 400, h: 384 };
    render(<EChart {...base} option={{ a: 1 }} lib={lib} />);
    expect(lib.init).toHaveBeenCalledTimes(1);
    report(0, 0);
    expect(instances[0].resize).not.toHaveBeenCalled();
    report(500, 384);
    expect(instances[0].resize).toHaveBeenCalledTimes(1);
  });

  it("leaves an unchanged config alone, even as a new object with keys in another order", () => {
    const { lib, instances } = makeLib();
    size = { w: 400, h: 384 };
    const { rerender } = render(<EChart {...base} option={{ a: 1, b: [1, 2] }} lib={lib} />);
    rerender(<EChart {...base} option={{ b: [1, 2], a: 1 }} lib={lib} />);
    expect(instances[0].setOption).toHaveBeenCalledTimes(1);
  });

  it("replaces a changed option with notMerge", () => {
    const { lib, instances } = makeLib();
    size = { w: 400, h: 384 };
    const { rerender } = render(<EChart {...base} option={{ a: 1 }} lib={lib} />);
    rerender(<EChart {...base} option={{ a: 2 }} lib={lib} />);
    expect(instances[0].setOption).toHaveBeenLastCalledWith({ a: 2 }, { notMerge: true });
    expect(lib.init).toHaveBeenCalledTimes(1);
  });

  it("treats formatting descriptors as part of the render config", () => {
    const { lib, instances } = makeLib();
    size = { w: 400, h: 384 };
    const { rerender } = render(<EChart {...base} option={{ a: 1 }} formats={{ y: "compact" }} lib={lib} />);
    rerender(<EChart {...base} option={{ a: 1 }} formats={{ y: "percent" }} lib={lib} />);
    expect(instances[0].setOption).toHaveBeenCalledTimes(2);
  });

  it("does not reset the chart for a size-only change", () => {
    const { lib, instances } = makeLib();
    size = { w: 400, h: 384 };
    const { rerender } = render(<EChart {...base} option={{ a: 1 }} lib={lib} />);
    rerender(<EChart {...base} height={500} option={{ a: 1 }} lib={lib} />);
    expect(instances[0].setOption).toHaveBeenCalledTimes(1);
    expect(instances[0].dispose).not.toHaveBeenCalled();
  });

  it("recreates the instance when theme, renderer or locale change", () => {
    const { lib, instances } = makeLib();
    size = { w: 400, h: 384 };
    const { rerender } = render(<EChart {...base} option={{ a: 1 }} lib={lib} />);
    rerender(<EChart {...base} theme="dark" option={{ a: 1 }} lib={lib} />);
    expect(instances[0].dispose).toHaveBeenCalled();
    expect(lib.init).toHaveBeenCalledTimes(2);
    expect(lib.init.mock.calls[1][1]).toBe("dark");
    expect(instances[1].setOption).toHaveBeenCalledWith({ a: 1 }, { notMerge: true });
    rerender(<EChart {...base} theme="dark" locale="DE" option={{ a: 1 }} lib={lib} />);
    expect(lib.init).toHaveBeenCalledTimes(3);
  });

  it("resizes again when revealed", () => {
    const { lib, instances } = makeLib();
    size = { w: 400, h: 384 };
    const { rerender } = render(<EChart {...base} option={{ a: 1 }} lib={lib} />);
    rerender(<EChart {...base} active={false} option={{ a: 1 }} lib={lib} />);
    rerender(<EChart {...base} active option={{ a: 1 }} lib={lib} />);
    expect(instances[0].resize).toHaveBeenCalled();
  });

  it("hands a box plot's box and outlier series to ECharts together, under one name", () => {
    // What ECharts then does with the shared name (one legend entry toggling both) is checked in
    // the browser, not here.
    const { lib, instances } = makeLib();
    size = { w: 400, h: 384 };
    const option = {
      series: [
        { id: "p:b", name: "Scores", type: "boxplot", data: [[1, 3, 5, 7, 8]] },
        { id: "g:b:outliers", name: "Scores", type: "scatter", data: [[0, 100]] },
      ],
    };
    render(<EChart {...base} option={option} lib={lib} />);
    const sent = instances[0].setOption.mock.calls[0][0];
    expect(sent.series.map((s: any) => [s.id, s.name, s.type])).toEqual([
      ["p:b", "Scores", "boxplot"],
      ["g:b:outliers", "Scores", "scatter"],
    ]);
  });

  it("disposes and disconnects on unmount", () => {
    const { lib, instances } = makeLib();
    size = { w: 400, h: 384 };
    const { unmount } = render(<EChart {...base} option={{ a: 1 }} lib={lib} />);
    unmount();
    expect(instances[0].dispose).toHaveBeenCalled();
    expect(observers[0].disconnect).toHaveBeenCalled();
  });
});
