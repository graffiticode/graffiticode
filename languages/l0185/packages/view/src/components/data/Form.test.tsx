// SPDX-License-Identifier: MIT
import React from "react";
import { describe, expect, test, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Form, isTable, toCsv } from "./Form";

const state = (data: unknown, errors: any[] = []) => ({ state: { data, errors, apply: () => {} } as any });

afterEach(cleanup);

describe("shape", () => {
  test("a list of flat records is a table", () => {
    expect(isTable([{ a: 1 }, { b: "x" }])).toBe(true);
    expect(isTable([{ a: { b: 1 } }])).toBe(false);
    expect(isTable([1, 2])).toBe(false);
    expect(isTable({ a: 1 })).toBe(false);
  });

  test("csv quotes what needs quoting, and uses every field", () => {
    expect(toCsv([{ a: 1, b: 'say "hi"' }, { c: "x,y" }])).toBe('a,b,c\n1,"say ""hi""",\n,,"x,y"');
  });
});

describe("Form", () => {
  test("renders records as a table, numbers right-aligned, with counts", () => {
    render(<Form {...state([{ city: "Oslo", population: 709 }, { city: "Bergen", population: null }])} />);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["city", "population"]);
    expect(screen.getByText("709").className).toContain("text-right");
    expect(screen.getByText("2 records · 2 fields")).toBeTruthy();
  });

  test("pages a large table", () => {
    render(<Form {...state(Array.from({ length: 450 }, (_, i) => ({ n: i })))} />);
    expect(screen.getAllByRole("row")).toHaveLength(201);
    fireEvent.click(screen.getByText("Show 200 more"));
    expect(screen.getAllByRole("row")).toHaveLength(401);
    expect(screen.getByText("Show 50 more")).toBeTruthy();
  });

  test("renders anything else as a tree, and collapses it", () => {
    render(<Form {...state({ meta: { total: 2 }, users: ["Ann"] })} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText('"Ann"')).toBeTruthy();
    fireEvent.click(screen.getByText("{2}").closest("button")!);
    expect(screen.queryByText('"Ann"')).toBeNull();
  });

  test("errors are alerts, and replace the data", () => {
    render(<Form {...state([{ a: 1 }], [{ message: "where: no field \"x\"" }])} />);
    expect(screen.getByRole("alert").textContent).toBe('where: no field "x"');
    expect(screen.queryByRole("table")).toBeNull();
  });

  test("an empty list says so", () => {
    render(<Form {...state([])} />);
    expect(screen.getByText("No records.")).toBeTruthy();
  });
});
