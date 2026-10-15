// SPDX-License-Identifier: MIT
/**
 * Resolve-then-sign, in the browser (jsdom). The Learnosity SDK and the signing compile are
 * stubbed at their boundaries: `window.LearnosityApp` (whose stub writes each question it is
 * given into its response span, as the real one renders it) and `fetch` (L0176's own
 * `POST /compile`). These assert on what reaches `LearnosityApp.init` and on the compiles
 * made, not just on markup.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import { Form } from "./Form";
import { INIT_DATA_CODE, getLangUrl } from "./sign";

let init: ReturnType<typeof vi.fn>;
let compiles: { url: string; body: any }[];
let signReply: (body: any) => any;

// What L0176's server answers for `init data {}` when the system session signs: the signed
// request (no `type`), with the payload's fields in it.
const signed = (body: any) => ({
  data: { consumer_key: "K", timestamp: "t", signature: "$02$signed", user_id: "u", ...body.data.data },
  errors: [],
  cache: false,
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      compiles.push({ url: String(url), body });
      return { json: async () => signReply(body) };
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
    expect(compiles[0].url).toBe(`${getLangUrl()}/compile`);
    expect(compiles[0].body.code).toEqual(INIT_DATA_CODE);
    const posted = compiles[0].body.data;
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
    expect(compiles[0].body.data).toEqual(l0158([mcq]));
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
    signReply = (body) => ({ data: { ...body.data, signing: { unsigned: "unavailable", message } }, errors: [], cache: false });
    mount(l0158([mcq]));
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    await settle();
    expect(compiles).toHaveLength(1);
    expect(init).not.toHaveBeenCalled();
    expect(document.querySelector('script[src*="learnosity.com"]')).toBeNull();
  });

  test("an unsigned answer with no reason shows the plain message", async () => {
    signReply = (body) => ({ data: { ...body.data }, errors: [], cache: false });
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
      release = () => resolve({ json: async () => signed(JSON.parse(opts.body)) });
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
