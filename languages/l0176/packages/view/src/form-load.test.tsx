// SPDX-License-Identifier: MIT
/**
 * The /form bundle end to end in jsdom: the shared View (@graffiticode/l0000-view 0.5.0)
 * loads an L0158 item's data from the api, carrying the compile generation of the `?url=` the
 * api's /form redirect passed, and L0176's Form resolves and signs it. The View does this
 * itself; L0176 installs nothing around it. `fetch` stands in for the api (`/data`, and
 * `/preview/sign` for the signing); `window.LearnosityApp` for the SDK.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor, act, cleanup } from "@testing-library/react";
import { SWRConfig } from "swr";
import { View } from "@graffiticode/l0000-view";
import { Form } from "./components/form";

const ID = "l0158-task-id";
const ACTIVITY = {
  type: "questions",
  data: {
    id: "act-1", name: "L0158 item", session_id: "s-1",
    questions: [{ response_id: "artcompiler-mcq-x-0", type: "mcq", stimulus: "What is {{var:A1}} + 5?" }],
    dynamic_content_data: { cols: ["A1"], rows: { r1: { values: ["7"] } } },
  },
};

let urls: string[];
let init: ReturnType<typeof vi.fn>;

beforeEach(() => {
  urls = [];
  init = vi.fn();
  (window as any).LearnosityApp = { init };
  if (typeof (globalThis as any).CSS?.escape !== "function") {
    vi.stubGlobal("CSS", { escape: (s: string) => s });
  }
  vi.stubGlobal("fetch", vi.fn(async (url: string, opts: any) => {
    urls.push(String(url));
    if (String(url).includes("/data?")) {
      return { json: async () => ({ status: "success", data: ACTIVITY }) };
    }
    const body = JSON.parse(opts.body);
    return { status: 200, ok: true, json: async () => ({ request: { signature: "$02$signed", ...body.activity.data } }) };
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as any).LearnosityApp;
});

const formSearch = (dataUrl: string) => `?id=${ID}&url=${encodeURIComponent(dataUrl)}`;

function mount(search: string) {
  // The View reads `?url=` from the page it is mounted in.
  window.history.replaceState({}, "", `/form${search}`);
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <View Form={Form} id={ID} />
    </SWRConfig>,
  );
}

async function rendered() {
  await waitFor(() => expect(document.querySelector('script[src*="learnosity.com"]')).toBeTruthy());
  await act(async () => {
    document.querySelectorAll<HTMLScriptElement>('script[src*="learnosity.com"]').forEach((s) => s.onload?.(new Event("load")));
  });
  await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
}

describe("the data load", () => {
  test("carries the generation of the data URL it was given, and the item renders resolved and signed", async () => {
    mount(formSearch(`https://api.graffiticode.org/data?id=${ID}&access_token=tok&generation=g-2026-10-15`));
    await rendered();
    const data = urls.filter((u) => u.includes("/data?"));
    expect(data).toHaveLength(1);
    const query = new URL(data[0]).searchParams;
    expect(query.get("id")).toBe(ID);
    expect(query.get("generation")).toBe("g-2026-10-15");
    // The credential goes in the header, as the View sends it; never copied into the query.
    expect(query.get("access_token")).toBeNull();
    // Signed through the same api host's /preview/sign; nothing goes to a /compile.
    expect(urls.filter((u) => u.endsWith("/compile"))).toHaveLength(0);
    expect(urls.filter((u) => u.endsWith("/preview/sign"))).toEqual([`${new URL(data[0]).origin}/preview/sign`]);
    expect(init.mock.calls[0][0]).toMatchObject({ signature: "$02$signed", questions: [{ stimulus: "What is 7 + 5?" }] });
  });

  test("without a generation the View loads exactly as before", async () => {
    mount(formSearch(`https://api.graffiticode.org/data?id=${ID}`));
    await rendered();
    const data = urls.filter((u) => u.includes("/data?"));
    expect(data).toHaveLength(1);
    expect(new URL(data[0]).searchParams.get("generation")).toBeNull();
  });

  test("goes only to the View's own api host, whatever host the URL names", async () => {
    mount(formSearch(`https://elsewhere.example/data?id=${ID}&generation=g1`));
    await rendered();
    const data = urls.filter((u) => u.includes("/data?"));
    expect(data.every((u) => !u.includes("elsewhere.example"))).toBe(true);
    expect(new URL(data[0]).searchParams.get("generation")).toBe("g1");
  });
});
