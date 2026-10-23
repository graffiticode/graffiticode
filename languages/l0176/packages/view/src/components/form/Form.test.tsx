// SPDX-License-Identifier: MIT
/**
 * Resolve-then-sign, in the browser (jsdom). The Learnosity SDK and the signing compile are
 * stubbed at their boundaries: `window.LearnosityApp` (whose stub writes each question it is
 * given into its response span, as the real one renders it) and `fetch` (the api's
 * `POST /preview/sign`). These assert on what reaches `LearnosityApp.init` and on the signing
 * requests made, not just on markup.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import { Form, EXPIRED_MESSAGE, SAVED_MESSAGE } from "./Form";
import { BUSY_MESSAGE, getSignUrl } from "./sign";

let init: ReturnType<typeof vi.fn>;
let compiles: { url: string; method: string; headers: Record<string, string>; body: any }[];
let signReply: (body: any) => any;
let signStatus: number;

// What the api's /preview/sign answers when the system session signs: the signed request
// (no `type`), with the payload's fields in it.
const signed = (body: any) => ({
  request: { consumer_key: "K", timestamp: "t", signature: "$02$signed", user_id: "u", ...body.activity.data },
});

beforeEach(() => {
  init = vi.fn((request: any) => {
    for (const q of request.questions ?? []) {
      const el = document.querySelector(`.learnosity-response.question-${q.response_id}`);
      if (el) el.textContent = JSON.stringify(q);
    }
  });
  (window as any).LearnosityApp = { init };
  (window as any).LearnosityItems = { init };
  if (typeof (globalThis as any).CSS?.escape !== "function") {
    vi.stubGlobal("CSS", { escape: (s: string) => s });
  }
  compiles = [];
  signReply = signed;
  signStatus = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      compiles.push({ url: String(url), method: opts.method, headers: opts.headers ?? {}, body });
      const status = signStatus;
      return { status, ok: status >= 200 && status < 300, json: async () => signReply(body) };
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as any).LearnosityApp;
  delete (window as any).LearnosityItems;
});

const mount = (data: any) => render(<Form state={{ data, errors: [], apply: () => {} }} />);

// jsdom never fetches the Learnosity script; fire its load as the browser would.
async function loadLearnosity() {
  await waitFor(() => expect(document.querySelector('script[src*="learnosity.com"]')).toBeTruthy());
  await act(async () => {
    document.querySelectorAll<HTMLScriptElement>('script[src*="learnosity.com"]').forEach((s) => s.onload?.(new Event("load")));
  });
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

const DCD = { cols: ["A1"], rows: { r1: { values: ["7"] }, r2: { values: ["11"] } } };

// An L0158 item as its compile now emits it: unsigned, inline questions with response_id.
const l0158 = (questions: any[], extra: any = {}) => ({
  type: "questions",
  data: { id: "act-1", name: "L0158 item", session_id: "s-1", questions, ...extra },
});

describe("resolve, then sign", () => {
  test("(a) a dynamic custom question shows the picked row, and Learnosity gets the signed request", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.75); // the second row: A1 = 11
    const custom = {
      response_id: "artcompiler-custom-x-0",
      type: "custom",
      stimulus: "Fill in {{var:A1}}",
      js: { question: "https://l0166.graffiticode.org/question.js" },
      data: { lang: "0166", interaction: { cells: { A1: { text: "{{var:A1}}" } } } },
    };
    mount(l0158([custom], { dynamic_content_data: DCD }));
    await loadLearnosity();
    await waitFor(() => expect(init).toHaveBeenCalledTimes(1));

    expect(compiles).toHaveLength(1);
    const posted = compiles[0].body.activity;
    expect(posted.type).toBe("questions");
    expect(posted.request).toBeUndefined();
    expect(JSON.stringify(posted)).not.toMatch(/\{\{var:/);
    expect(posted.data.questions[0].data.interaction.cells.A1.text).toBe("11");

    const request = init.mock.calls[0][0];
    expect(request.signature).toBe("$02$signed");
    expect(request.questions[0].data.interaction.cells.A1.text).toBe("11");
    expect(request.questions[0].stimulus).toBe("Fill in 11");
    expect(document.body.textContent).toContain("11");
    expect(document.body.textContent).not.toContain("{{var:A1}}");
  });

  test("(b) a dynamic built-in question is resolved before it is signed", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // the first row: A1 = 7
    const mcq = {
      response_id: "artcompiler-mcq-x-0",
      type: "mcq",
      stimulus: "What is {{var:A1}} + 5?",
      options: [{ label: "{{var:A1}}5", value: "0" }, { label: "12", value: "1" }],
    };
    mount(l0158([mcq], { dynamic_content_data: DCD }));
    await loadLearnosity();
    await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
    expect(compiles).toHaveLength(1);
    const request = init.mock.calls[0][0];
    expect(request.questions[0].stimulus).toBe("What is 7 + 5?");
    expect(request.questions[0].options[0].label).toBe("75");
    expect(screen.getByText(/What is 7 \+ 5\?/)).toBeTruthy();
  });

  test("an already-signed L0176 activity with dynamic data is signed again, resolved", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const mcq = { response_id: "artcompiler-mcq-t-0", type: "mcq", stimulus: "{{var:A1}}?" };
    const data = l0158([mcq], { dynamic_content_data: DCD });
    mount({ ...data, request: { signature: "$02$compiled", questions: [mcq] } });
    await loadLearnosity();
    await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
    expect(compiles).toHaveLength(1);
    expect(init.mock.calls[0][0].signature).toBe("$02$signed");
    expect(init.mock.calls[0][0].questions[0].stimulus).toBe("7?");
  });

  test("an already-signed items activity is never re-signed, even with dynamic data", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const q = { response_id: "artcompiler-mcq-t-0", type: "mcq", stimulus: "{{var:A1}}?" };
    const request = { security: { signature: "$02$own-connection" }, request: { items: ["bank-item-1"], questions: [q] } };
    const activity = { type: "items", data: { id: "a", name: "n", session_id: "s", questions: [q], dynamic_content_data: DCD }, request };
    mount(activity);
    await loadLearnosity();
    await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
    await settle();
    expect(compiles).toEqual([]);
    expect(init.mock.calls[0][0]).toBe(request);
  });

  test("an unsigned items activity (no request) is still signed", async () => {
    const q = { response_id: "artcompiler-mcq-x-0", type: "mcq", stimulus: "2 + 2?" };
    mount({ type: "items", data: { id: "a", name: "n", session_id: "s", questions: [q] } });
    await loadLearnosity();
    await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
    expect(compiles).toHaveLength(1);
    expect(init.mock.calls[0][0].signature).toBe("$02$signed");
  });

  test("(c) a static unsigned activity is signed, then rendered", async () => {
    const mcq = { response_id: "artcompiler-mcq-x-0", type: "mcq", stimulus: "2 + 2?" };
    mount(l0158([mcq]));
    await loadLearnosity();
    await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
    expect(compiles).toHaveLength(1);
    expect(compiles[0].body).toEqual({ activity: l0158([mcq]) });
    expect(init.mock.calls[0][0]).toMatchObject({ signature: "$02$signed", questions: [mcq] });
  });

  test("(d) an already-signed static activity renders its own request, with no second compile", async () => {
    const mcq = { response_id: "artcompiler-mcq-t-0", type: "mcq", stimulus: "2 + 2?" };
    const request = { consumer_key: "K", signature: "$02$compiled", questions: [mcq] };
    mount({ ...l0158([mcq]), request });
    await loadLearnosity();
    await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
    await settle();
    expect(compiles).toEqual([]);
    expect(init.mock.calls[0][0]).toBe(request);
  });

  test("the same content handed down again (a new identity, a new session id) is not signed or initialized again", async () => {
    const mcq = { response_id: "artcompiler-mcq-x-0", type: "mcq", stimulus: "2 + 2?" };
    const view = mount(l0158([mcq]));
    await loadLearnosity();
    await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
    const again = l0158([{ ...mcq }]);
    again.data.session_id = "s-2";
    view.rerender(<Form state={{ data: again, errors: [], apply: () => {} }} />);
    await settle();
    expect(compiles).toHaveLength(1);
    expect(init).toHaveBeenCalledTimes(1);
  });
});

describe("without a signed request, the SDK is never initialized", () => {
  const mcq = { response_id: "artcompiler-mcq-x-0", type: "mcq", stimulus: "2 + 2?" };

  test("(e) signing unavailable shows L0176's message", async () => {
    const message = "Preview not signed: no system preview session is available. Select a Learnosity connection to sign it.";
    signReply = () => ({ signing: { unsigned: "unavailable", message } });
    mount(l0158([mcq]));
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    await settle();
    expect(compiles).toHaveLength(1);
    expect(init).not.toHaveBeenCalled();
    expect(document.querySelector('script[src*="learnosity.com"]')).toBeNull();
  });

  test("an unsigned answer with no reason shows the plain message", async () => {
    signReply = () => ({ signing: { unsigned: "signing-failed" } });
    mount(l0158([mcq]));
    expect((await screen.findByRole("alert")).textContent).toBe("This preview couldn't be signed.");
    expect(init).not.toHaveBeenCalled();
  });

  test("an unreachable signing server shows the message too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    mount(l0158([mcq]));
    expect((await screen.findByRole("alert")).textContent).toMatch(/^This preview couldn't be signed\. \(network down\)/);
    expect(init).not.toHaveBeenCalled();
  });

  test("a refused activity (a cached legacy shape) shows the compile error", async () => {
    signReply = () => ({ data: null, errors: [{ message: "Error: init: questions[0] needs a type and response_id." }], cache: false });
    mount(l0158([{ type: "mcq", reference: "r", data: { type: "mcq" } }]));
    expect(await screen.findByText(/questions\[0\] needs a type and response_id/)).toBeTruthy();
    await settle();
    expect(init).not.toHaveBeenCalled();
  });

  test("a value with a Learnosity type but no activity or request shows the message, with no compile", async () => {
    mount({ type: "questions", signing: { unsigned: "not-configured", message: "Preview not signed: not configured." } });
    expect((await screen.findByRole("alert")).textContent).toBe("Preview not signed: not configured.");
    await settle();
    expect(compiles).toEqual([]);
    expect(init).not.toHaveBeenCalled();
  });

  test("while signing is in flight nothing is initialized", async () => {
    let release!: () => void;
    vi.stubGlobal("fetch", vi.fn((_url: string, opts: any) => new Promise((resolve) => {
      release = () => resolve({ status: 200, ok: true, json: async () => signed(JSON.parse(opts.body)) });
    })));
    mount(l0158([mcq]));
    await settle();
    expect(screen.getByRole("status")).toBeTruthy();
    expect(document.querySelector('script[src*="learnosity.com"]')).toBeNull();
    expect(init).not.toHaveBeenCalled();
    await act(async () => release());
    await loadLearnosity();
    await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
  });
});

describe("the signing request", () => {
  const mcq = { response_id: "artcompiler-mcq-x-0", type: "mcq", stimulus: "2 + 2?" };

  test("goes to exactly POST <api>/preview/sign, with only the activity and no connection, never to /compile", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const compiled = { signature: "$02$compiled", questions: [mcq] };
    const data = l0158([{ ...mcq, stimulus: "{{var:A1}}?" }], { dynamic_content_data: DCD });
    mount({ ...data, request: compiled, signing: { unsigned: "stale" } });
    await loadLearnosity();
    await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
    expect(compiles).toHaveLength(1);
    const [call] = compiles;
    // jsdom's page is on localhost, so the api is the dev api, as for the View's data load.
    expect(call.url).toBe("http://localhost:3100/preview/sign");
    expect(call.url).toBe(getSignUrl());
    expect(call.method).toBe("POST");
    expect(call.url).not.toMatch(/\/compile$/);
    expect(call.url).not.toMatch(/l0176\.graffiticode\.org|:50176/);
    // The resolved activity and nothing else: no code, connection, request, signing or credential.
    expect(Object.keys(call.body)).toEqual(["activity"]);
    expect(Object.keys(call.body.activity).sort()).toEqual(["data", "type"]);
    expect(call.body.activity.data.questions[0].stimulus).toBe("7?");
    expect(JSON.stringify(call.body)).not.toMatch(/connection|\$02\$compiled|"request"|"signing"/);
    expect(Object.keys(call.headers).map((h) => h.toLowerCase())).toEqual(["content-type"]);
    const calls = (globalThis.fetch as any).mock.calls as any[][];
    expect(calls.every(([url]) => !String(url).endsWith("/compile"))).toBe(true);
  });

  test("goes to the production api off localhost", () => {
    expect(getSignUrl("https://api.graffiticode.org")).toBe("https://api.graffiticode.org/preview/sign");
  });

  test.each([
    ["the api's 429", 429, () => ({ status: "error", error: { message: "Too many requests" } })],
    ["a 429 with no readable body", 429, () => { throw new Error("no json"); }],
    ["Policy's rate-limited", 200, () => ({ signing: { unsigned: "rate-limited", message: "Previews are busy right now; try again in a moment." } })],
    ["Broker's session-exhausted", 200, () => ({ signing: { unsigned: "session-exhausted", message: "any text" } })],
  ])("%s shows the busy message, and the SDK is never initialized", async (_, status, reply) => {
    signStatus = status;
    signReply = reply;
    mount(l0158([mcq]));
    expect((await screen.findByRole("alert")).textContent).toBe("Previews are busy right now; try again in a moment.");
    expect(BUSY_MESSAGE).not.toBe("This preview couldn't be signed.");
    await settle();
    expect(compiles).toHaveLength(1);
    expect(init).not.toHaveBeenCalled();
    expect(document.querySelector('script[src*="learnosity.com"]')).toBeNull();
  });

  test("a gateway-only answer shows its own message, not the busy one", async () => {
    const message = "Preview not signed: a preview without a connection is signed only through the Graffiticode api.";
    signReply = () => ({ signing: { unsigned: "gateway-only", message } });
    mount(l0158([mcq]));
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(init).not.toHaveBeenCalled();
  });

  test("another 4xx is \"couldn't be signed\", with the api's reason", async () => {
    signStatus = 400;
    signReply = () => ({ status: "error", error: { message: "activity must be a questions or items activity" } });
    mount(l0158([mcq]));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This preview couldn't be signed. (activity must be a questions or items activity)",
    );
    await settle();
    expect(init).not.toHaveBeenCalled();
  });
});

describe("a signed request's expiry matters only before Learnosity starts", () => {
  const lt = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  };
  const mcq = { response_id: "artcompiler-mcq-e-0", type: "mcq", stimulus: "2 + 2?" };
  const questions = (expiresAt: number) => ({
    ...l0158([mcq]),
    request: { consumer_key: "K", signature: "$02$compiled", expires: lt(expiresAt), questions: [mcq] },
  });

  test("a fresh questions request is used as is", async () => {
    const data = questions(Date.now() + 10 * 60_000);
    mount(data);
    await loadLearnosity();
    await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
    expect(compiles).toEqual([]);
    expect(init.mock.calls[0][0]).toBe(data.request);
  });

  test("a stale questions request is signed again once, then started", async () => {
    mount(questions(Date.now() - 60_000));
    await loadLearnosity();
    await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
    expect(compiles).toHaveLength(1);
    expect(init.mock.calls[0][0]).toMatchObject({ signature: "$02$signed" });
  });

  test("a stale items request can't be signed again, so it says it has expired", async () => {
    const items = {
      type: "items",
      data: { id: "act-1", name: "item", session_id: "s-1", items: [] },
      request: { security: { consumer_key: "K", expires: lt(Date.now() - 60_000), signature: "$02$x" }, request: { items: [] } },
    };
    mount(items);
    expect((await screen.findByRole("alert")).textContent).toBe(EXPIRED_MESSAGE);
    await settle();
    expect(compiles).toEqual([]);
    expect(init).not.toHaveBeenCalled();
  });

  test("REGRESSION: a started assessment survives its expiry: no re-sign, no second init, answers kept", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = Date.now();
      const data = questions(start + 10 * 60_000);
      const view = mount(data);
      await loadLearnosity();
      await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
      // A learner's answer, in the DOM Learnosity rendered into.
      const span = document.querySelector(`.learnosity-response.question-${mcq.response_id}`)!;
      const answer = document.createElement("input");
      answer.value = "4";
      answer.id = "learner-answer";
      span.appendChild(answer);

      vi.setSystemTime(start + 30 * 60_000);
      // The same content handed down again: a new identity, new errors array, unrelated state.
      view.rerender(<Form state={{ data: { ...data, request: { ...data.request } }, errors: [], apply: () => {} }} />);
      view.rerender(<Form state={{ data: { ...data }, errors: [], apply: () => {} }} />);
      await settle();

      expect(compiles).toEqual([]);
      expect(init).toHaveBeenCalledTimes(1);
      expect((document.getElementById("learner-answer") as HTMLInputElement | null)?.value).toBe("4");
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the saved marker", () => {
  const mcq = { response_id: "artcompiler-mcq-t-0-0", type: "mcq", stimulus: "2 + 2?" };
  const request = { consumer_key: "K", signature: "$02$compiled", questions: [mcq] };
  // The broker's write-items result, as L0176 attaches it (data.itemBank).
  const itemSave = { saved: true, references: ["gc-item-1"], questionReferences: ["gc-q-1"] };
  const questionSave = { saved: true, references: ["gc-q-1", "gc-q-2"], questionReferences: ["gc-q-1", "gc-q-2"] };
  const markerOf = (itemBank: any) => {
    mount({ ...l0158([mcq], itemBank === undefined ? {} : { itemBank }), request });
    return screen.queryByText(SAVED_MESSAGE);
  };

  test("a saved activity says so, with the saved references", async () => {
    expect(markerOf(itemSave)).toBeTruthy();
    expect(screen.getByText("References: gc-item-1")).toBeTruthy();
  });

  test("a question-only save gets the same generic wording, with its question references", async () => {
    const marker = markerOf(questionSave);
    expect(marker).toBeTruthy();
    expect(screen.getByText("References: gc-q-1, gc-q-2")).toBeTruthy();
    const text = marker!.closest('[role="status"]')!.textContent!;
    expect(text).not.toMatch(/draft/i);
    expect(text).not.toMatch(/\bitems?\b(?! bank)/i);
  });

  test("nothing is shown for a skipped save, or without one", async () => {
    expect(markerOf({ skipped: "no-connection", fn: "save-to-itembank", occurrence: "n1" })).toBeNull();
    cleanup();
    expect(markerOf(undefined)).toBeNull();
  });

  // The Form can't tell who is viewing: the owner, a grant recipient through a shared
  // connection (whose saves land in the owner's bank), or a publication viewer all receive the
  // same stored artifact, so the wording must hold for every one of them.
  test.each(["the connection owner", "a grant recipient", "a publication viewer"])(
    "the same saved artifact reads owner-neutrally for %s",
    async () => {
      const marker = markerOf(itemSave);
      expect(marker!.closest('[role="status"]')!.textContent).not.toMatch(/\byour\b/i);
    },
  );

  test("an items activity shows it too", async () => {
    mount({ type: "items", data: { items: ["gc-item-1"], itemBank: itemSave }, request: { security: {}, request: {} } });
    expect(screen.getByText(SAVED_MESSAGE)).toBeTruthy();
  });
});
