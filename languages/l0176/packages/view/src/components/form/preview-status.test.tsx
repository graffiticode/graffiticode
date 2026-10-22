// SPDX-License-Identifier: MIT
/**
 * The Form's report to a framing host (the MCP widget): `preview-ready` only from Learnosity's
 * readyListener, `preview-error` when that will never come, each at most once per mount, and
 * only to the `origin` the page was given. The SDK and `fetch` are stubbed at their boundaries,
 * as in Form.test.tsx; the parent window is a stub that records what it is sent.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor, act, cleanup } from "@testing-library/react";
import { Form } from "./Form";
import { createPreviewStatus, previewTargetOrigin } from "./preview-status";

const HOST = "https://host.example";
let posted: { message: any; targetOrigin: string }[];
let init: ReturnType<typeof vi.fn>;
let listeners: { readyListener?: () => void; errorListener?: (e: any) => void };
let signReply: () => any;

const mcq = { response_id: "artcompiler-mcq-t-0", type: "mcq", stimulus: "2 + 2?" };
const activity = (extra: any = {}) => ({
  type: "questions",
  data: { id: "act-1", name: "item", session_id: "s-1", questions: [mcq] },
  ...extra,
});
const signedActivity = () => activity({ request: { consumer_key: "K", signature: "$02$compiled", questions: [mcq] } });

const setSearch = (search: string) => window.history.replaceState({}, "", `/form${search}`);

beforeEach(() => {
  posted = [];
  Object.defineProperty(window, "parent", {
    configurable: true,
    value: { postMessage: (message: any, targetOrigin: string) => posted.push({ message, targetOrigin }) },
  });
  setSearch(`?id=t1&origin=${encodeURIComponent(HOST)}`);
  listeners = {};
  init = vi.fn((_request: any, cbs: any) => {
    listeners = cbs;
  });
  (window as any).LearnosityApp = { init };
  (window as any).LearnosityItems = { init };
  if (typeof (globalThis as any).CSS?.escape !== "function") {
    vi.stubGlobal("CSS", { escape: (s: string) => s });
  }
  signReply = () => ({ signing: { unsigned: "unavailable", message: "No system preview session." } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ status: 200, ok: true, json: async () => signReply() })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as any).LearnosityApp;
  delete (window as any).LearnosityItems;
  Object.defineProperty(window, "parent", { configurable: true, value: window });
  setSearch("");
});

const mount = (data: any, errors: any[] = []) => render(<Form state={{ data, errors, apply: () => {} }} />);

async function loadLearnosity() {
  await waitFor(() => expect(document.querySelector('script[src*="learnosity.com"]')).toBeTruthy());
  await act(async () => {
    document.querySelectorAll<HTMLScriptElement>('script[src*="learnosity.com"]').forEach((s) => s.onload?.(new Event("load")));
  });
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

describe("preview status to a framing host", () => {
  test("ready is posted once, to the given origin, only when Learnosity's readyListener fires", async () => {
    mount(signedActivity());
    await loadLearnosity();
    await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
    await settle();
    expect(posted).toEqual([]);
    act(() => listeners.readyListener?.());
    act(() => listeners.readyListener?.());
    expect(posted).toEqual([{ message: { type: "preview-ready" }, targetOrigin: HOST }]);
  });

  test("a Learnosity error is reported, and a later ready is not", async () => {
    mount(signedActivity());
    await loadLearnosity();
    await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
    vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => listeners.errorListener?.({ code: 10003, msg: "Failed authentication" }));
    act(() => listeners.readyListener?.());
    expect(posted).toEqual([{ message: { type: "preview-error", reason: "learnosity: 10003" }, targetOrigin: HOST }]);
  });

  test("the SDK script failing to load is reported", async () => {
    mount(signedActivity());
    await waitFor(() => expect(document.querySelector('script[src*="learnosity.com"]')).toBeTruthy());
    vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => {
      document.querySelector<HTMLScriptElement>('script[src*="learnosity.com"]')!.onerror?.(new Event("error"));
    });
    expect(posted).toEqual([{ message: { type: "preview-error", reason: "script-load" }, targetOrigin: HOST }]);
  });

  test("an unsigned preview is reported with its reason, and nothing is initialized", async () => {
    mount(activity());
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      message: { type: "preview-error", reason: "unsigned: No system preview session." },
      targetOrigin: HOST,
    });
    expect(init).not.toHaveBeenCalled();
  });

  test("nothing is posted while signing is still in flight", async () => {
    let release: (v: any) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise((r) => { release = r; })));
    mount(activity());
    await settle();
    expect(posted).toEqual([]);
    release({ status: 200, ok: true, json: async () => signReply() });
    await waitFor(() => expect(posted).toHaveLength(1));
  });

  test("compile errors are reported", async () => {
    mount(signedActivity(), [{ message: "Error: something broke" }]);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].message).toEqual({ type: "preview-error", reason: "compile-errors" });
  });

  test("a value that isn't a Learnosity activity is reported", async () => {
    mount("hello");
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].message).toEqual({ type: "preview-error", reason: "not-an-activity" });
  });

  test("without an origin param nothing is posted, ready or error", async () => {
    setSearch("?id=t1");
    mount(signedActivity());
    await loadLearnosity();
    await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
    act(() => listeners.readyListener?.());
    await settle();
    expect(posted).toEqual([]);
  });
});

describe("previewTargetOrigin", () => {
  test("accepts a bare origin only", () => {
    expect(previewTargetOrigin(`?origin=${encodeURIComponent(HOST)}`)).toBe(HOST);
    expect(previewTargetOrigin("?origin=http%3A%2F%2Flocalhost%3A3000")).toBe("http://localhost:3000");
    expect(previewTargetOrigin(`?origin=${encodeURIComponent(`${HOST}/path`)}`)).toBeNull();
    expect(previewTargetOrigin("?origin=*")).toBeNull();
    expect(previewTargetOrigin("?origin=not%20a%20url")).toBeNull();
    expect(previewTargetOrigin("")).toBeNull();
  });

  test("a top-level page (no parent) posts nothing", () => {
    const send = createPreviewStatus(HOST, null);
    expect(() => send({ type: "preview-ready" })).not.toThrow();
  });
});
