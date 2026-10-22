// SPDX-License-Identifier: MIT
/**
 * /form?source=parent: the embedding page hands the item in; this page fetches nothing.
 *
 * The payload is what the MCP widget holds: `render_item` hydration's `data`, the compile
 * ENVELOPE `{ data: activity, errors }`, not a bare activity. These drive the real Form, with
 * the Learnosity SDK and `fetch` stubbed at their boundaries and the parent window a stub
 * that records what it is sent.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor, act, cleanup, screen } from "@testing-library/react";
import { Form } from "./Form";
import { ParentFed, asEnvelope } from "./parent-fed";

const HOST = "https://mcp-app-0123.web-sandbox.oaiusercontent.com";
let posted: { message: any; targetOrigin: string }[];
let parent: { postMessage: (m: any, o: string) => void };
let init: ReturnType<typeof vi.fn>;
let fetches: number;

const lt = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
};
const mcq = { response_id: "artcompiler-mcq-t-0", type: "mcq", stimulus: "2 + 2?" };
const signedActivity = () => ({
  type: "questions",
  data: { id: "act-1", name: "item", session_id: "s-1", questions: [mcq] },
  request: { consumer_key: "K", signature: "$02$compiled", expires: lt(Date.now() + 10 * 60_000), questions: [mcq] },
});
// Exactly what render_item's _meta.graffiticode.data carries for a ready L0176 item.
const hydrationEnvelope = (errors: any[] = []) => ({ data: signedActivity(), errors });

/** A message event as the browser delivers it. jsdom's MessageEvent rejects a stub source. */
function deliver(data: any, { origin = HOST, source = parent as any }: { origin?: string; source?: any } = {}) {
  const event = new Event("message");
  Object.defineProperties(event, { data: { value: data }, origin: { value: origin }, source: { value: source } });
  act(() => {
    window.dispatchEvent(event);
  });
}

async function loadLearnosity() {
  await waitFor(() => expect(document.querySelector('script[src*="learnosity.com"]')).toBeTruthy());
  await act(async () => {
    document.querySelectorAll<HTMLScriptElement>('script[src*="learnosity.com"]').forEach((s) => s.onload?.(new Event("load")));
  });
}

beforeEach(() => {
  posted = [];
  parent = { postMessage: (message: any, targetOrigin: string) => posted.push({ message, targetOrigin }) };
  Object.defineProperty(window, "parent", { configurable: true, value: parent });
  window.history.replaceState({}, "", `/form?source=parent&origin=${encodeURIComponent(HOST)}`);
  init = vi.fn();
  (window as any).LearnosityApp = { init };
  (window as any).LearnosityItems = { init };
  if (typeof (globalThis as any).CSS?.escape !== "function") vi.stubGlobal("CSS", { escape: (s: string) => s });
  fetches = 0;
  vi.stubGlobal("fetch", vi.fn(async () => { fetches += 1; return { status: 200, ok: true, json: async () => ({}) }; }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as any).LearnosityApp;
  delete (window as any).LearnosityItems;
  Object.defineProperty(window, "parent", { configurable: true, value: window });
  window.history.replaceState({}, "", "/");
});

describe("ParentFed", () => {
  test("asks its parent for the item, at the given origin only, and fetches nothing", async () => {
    render(<ParentFed Form={Form} />);
    await waitFor(() => expect(posted.length).toBeGreaterThan(0));
    expect(posted.every((p) => p.targetOrigin === HOST)).toBe(true);
    expect(posted[0].message).toEqual({ type: "preview-awaiting-data" });
    expect(fetches).toBe(0);
  });

  test("the real hydration envelope reaches Learnosity as the inner activity's request", async () => {
    render(<ParentFed Form={Form} />);
    await waitFor(() => expect(posted.length).toBeGreaterThan(0));
    const envelope = hydrationEnvelope();
    deliver({ type: "preview-data", data: envelope });
    await loadLearnosity();
    await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
    expect(init.mock.calls[0][0]).toBe(envelope.data.request);
    expect(fetches).toBe(0);
  });

  test("an envelope carrying compile errors shows them and reports preview-error", async () => {
    render(<ParentFed Form={Form} />);
    deliver({ type: "preview-data", data: hydrationEnvelope([{ message: "Error: something broke" }]) });
    expect(await screen.findByText("Error: something broke")).toBeTruthy();
    await waitFor(() => expect(posted.some((p) => p.message.type === "preview-error")).toBe(true));
    expect(posted.find((p) => p.message.type === "preview-error")!.message.reason).toBe("compile-errors");
    expect(init).not.toHaveBeenCalled();
  });

  test("a bare activity still works, and its own `data` field doesn't make it an envelope", async () => {
    render(<ParentFed Form={Form} />);
    const activity = signedActivity();
    deliver({ type: "preview-data", data: activity });
    await loadLearnosity();
    await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
    expect(init.mock.calls[0][0]).toBe(activity.request);
  });

  test("only the first preview-data counts; wrong origin or source is ignored", async () => {
    render(<ParentFed Form={Form} />);
    const first = signedActivity();
    deliver({ type: "preview-data", data: { data: { type: "questions", data: { questions: [] } }, errors: [] } }, { origin: "https://evil.example" });
    deliver({ type: "preview-data", data: { data: { type: "questions", data: { questions: [] } }, errors: [] } }, { source: window });
    deliver({ type: "preview-data", data: { data: first, errors: [] } });
    deliver({ type: "preview-data", data: { data: signedActivity(), errors: [{ message: "later" }] } });
    await loadLearnosity();
    await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
    expect(init.mock.calls[0][0]).toBe(first.request);
    expect(screen.queryByText("later")).toBeNull();
  });

  test("without an origin it asks for nothing and says why", async () => {
    window.history.replaceState({}, "", "/form?source=parent");
    render(<ParentFed Form={Form} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/needs an origin/);
    expect(posted).toEqual([]);
  });
});

describe("asEnvelope (the shared View's rule)", () => {
  test("an object with an errors array is an envelope; anything else is bare", () => {
    expect(asEnvelope({ data: 1, errors: [] })).toEqual({ data: 1, errors: [] });
    expect(asEnvelope({ errors: [{ message: "x" }] })).toEqual({ data: null, errors: [{ message: "x" }] });
    const activity = { type: "questions", data: { questions: [] } };
    expect(asEnvelope(activity)).toEqual({ data: activity, errors: [] });
    expect(asEnvelope({ data: 1, errors: "nope" })).toEqual({ data: { data: 1, errors: "nope" }, errors: [] });
    expect(asEnvelope("hello")).toEqual({ data: "hello", errors: [] });
  });
});
