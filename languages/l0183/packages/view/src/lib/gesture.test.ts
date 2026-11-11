// SPDX-License-Identifier: MIT
import { describe, expect, test } from "vitest";
import { startsDrag } from "./gesture";

describe("drag ownership", () => {
  test("a touch on a handle drags; on a tray body it taps or scrolls", () => {
    expect(startsDrag("touch", "handle")).toBe(true);
    expect(startsDrag("touch", "tray-body")).toBe(false);
  });
  test("a mouse or pen on a tray body drags", () => {
    expect(startsDrag("mouse", "tray-body")).toBe(true);
    expect(startsDrag("pen", "tray-body")).toBe(true);
  });
  test("a touch on a filled blank drags", () => {
    expect(startsDrag("touch", "blank")).toBe(true);
  });
});
