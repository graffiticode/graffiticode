// SPDX-License-Identifier: MIT
/**
 * What `app.ts` serves, and the four rules that are load-bearing about how.
 *
 * Three of the four are shipped bug fixes, and every one of them looks harmless to change
 * locally — there is no CDN in front of a dev server and no COEP-isolated host embedding it, so
 * the failures they prevent are invisible until they are in production. This file is where they
 * are pinned.
 *
 * Reads the assembled `static/` directory, which `npm run build` populates. Run the build first.
 */
import { describe, expect, it } from "vitest";
import { readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import request from "supertest";
import { parser } from "@graffiticode/parser";
import { lexicon } from "@graffiticode/l0182";
import { createApp } from "./app.js";

const app = createApp({ authUrl: "http://127.0.0.1:4100" });
const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "static");

describe("public assets are readable with no token", () => {
  // An agent reads these BEFORE it has a token, which is why the static middleware is mounted
  // above the auth middleware. Note that auth is not a gate either way — it attaches req.auth
  // and does not reject an anonymous request — so mounting below it would protect nothing
  // while breaking this.
  const PUBLIC = [
    "lexicon.json",
    "schema.json",
    "instructions.md",
    "language-info.json",
    "usage-guide.md",
    "scope.json",
    "template.gc",
    "spec.html",
  ];

  for (const file of PUBLIC) {
    it(`serves ${file} anonymously`, async () => {
      const res = await request(app).get(`/${file}`);
      expect(res.status).toBe(200);
      // `.text` is undefined for a type supertest does not buffer as text — template.gc has no
      // known content type — so read whichever of the two the response actually carried.
      expect((res.text ?? res.body)?.length, `${file} came back empty`).toBeGreaterThan(0);
    });
  }

  it("serves lexicon.js from lexicon.json, for the still-deployed console", async () => {
    // No lexicon.js is emitted. The console slices from the first "{" and parses, so plain
    // JSON works. Drop the alias once it migrates.
    const res = await request(app).get("/lexicon.js");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).survey).toBeDefined();
  });

  it("does not serve the surveys themselves", async () => {
    // The surveys in core's data/ are what the compiler reads, and nothing more: a survey its
    // taker could read ahead of taking it — or edit — would not be one.
    for (const f of ["civic-priorities-1.json", "team-retro-1.json", "school-1.json"]) {
      expect((await request(app).get(`/${f}`)).status, f).toBe(404);
    }
  });

  it("keeps GET / a health check rather than the embed's index.html", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("<html");
  });
});

describe("caching", () => {
  it("lets the hashed bundle be cached forever — a new build is a new name", async () => {
    const asset = readdirSync(path.join(STATIC_DIR, "assets")).find((f) => f.endsWith(".js"));
    expect(asset, "no hashed asset in static/assets — run npm run build").toBeTruthy();
    const res = await request(app).get(`/assets/${asset}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("immutable");
  });

  it("never lets /form be held, on any of the three headers", async () => {
    // The embed HTML names the content-hashed bundle it loads, so caching it caches the whole
    // deploy: new assets sit there unreferenced while every visitor keeps running the previous
    // build — a failure that looks exactly like a successful deploy. `no-cache` alone was not
    // enough behind Cloudflare, which served a HIT with `age: 1191` and rewrote the header.
    const res = await request(app).get("/form");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.headers["cdn-cache-control"]).toBe("no-store");
    expect(res.headers["cloudflare-cdn-cache-control"]).toBe("no-store");
  });
});

describe("cross-origin embedding", () => {
  it("sets Cross-Origin-Resource-Policy on every response", async () => {
    // Without it a COEP-isolated host — the claude.ai and chatgpt.com widget iframes — blocks
    // the /form frame outright.
    for (const url of ["/", "/form", "/lexicon.json"]) {
      const res = await request(app).get(url);
      expect(res.headers["cross-origin-resource-policy"], url).toBe("cross-origin");
    }
  });
});

describe("POST /compile", () => {
  it("compiles a survey, in the { data, errors } envelope", async () => {
    // The options come from the survey core holds, so this also proves the server can reach
    // `data/` from wherever it was started — the one thing a bundled path can get wrong.
    const code = await parser.parse(182, `survey [ id "team-retro" ]..`, lexicon);
    const res = await request(app).post("/compile").send({ code, data: {} });
    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([]);
    expect(res.body.data.survey.instance).toBe("team-retro-1");
    expect(res.body.data.survey.options.length).toBeGreaterThan(1);
  });

  it("rejects a request missing code or data with 400, not 500", async () => {
    const res = await request(app).post("/compile").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("code and data");
  });
});
