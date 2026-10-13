// SPDX-License-Identifier: MIT
// The SSRF boundary. Address checks are pure; the request path runs against a local stub server
// reached through the TEST-ONLY options (http allowed, a fake resolver, and loopback treated as
// "public") — options source text can never set.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { checkUrl, isPublicAddress, makeGuardedFetcher } from "./fetch.js";

describe("addresses", () => {
  const refused = [
    "127.0.0.1", "127.8.9.10", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "240.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:169.254.169.254", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:0:4136:e378::1",
  ];
  for (const a of refused) it(`refuses ${a}`, () => expect(isPublicAddress(a)).toBe(false));
  for (const a of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) it(`allows ${a}`, () => expect(isPublicAddress(a)).toBe(true));
});

describe("URLs", () => {
  const bad = [
    "http://example.org/x.json", "ftp://example.org/x", "https://user:pw@example.org/x", "https://example.org:8443/x",
    "https://localhost/x", "https://db.internal/x", "https://printer.local/x", "https://metadata.google.internal/x",
    "https://127.0.0.1/x", "https://2130706433/x", "https://0x7f.1/x", "https://[::1]/x", "https://169.254.169.254/latest",
  ];
  for (const u of bad) {
    it(`refuses ${u} before connecting`, () => expect(() => checkUrl(u)).toThrow(/cannot be fetched|is not a URL/));
  }
  it("never echoes a resolved address", () => {
    expect(() => checkUrl("https://2130706433/x")).toThrow(/^fetch: "https:\/\/2130706433\/x" cannot be fetched/);
  });
  it("allows a public https URL", () => expect(checkUrl("https://example.org/data.json").hostname).toBe("example.org"));
});

describe("requests (stub server)", () => {
  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const u = req.url ?? "/";
      if (u === "/data.json") return res.writeHead(200, { "content-type": "application/json" }).end('[{"a":1}]');
      if (u === "/to-private") return res.writeHead(302, { location: "http://evil.test:" + port + "/data.json" }).end();
      if (u === "/to-literal") return res.writeHead(302, { location: "http://127.0.0.2:" + port + "/data.json" }).end();
      if (u === "/to-ftp") return res.writeHead(302, { location: "ftp://good.test/x" }).end();
      if (u === "/loop") return res.writeHead(302, { location: "/loop" }).end();
      if (u === "/slow") return setTimeout(() => res.end("[]"), 2_000);
      if (u === "/big") return res.writeHead(200, { "content-type": "application/json" }).end("[" + "1,".repeat(600_000) + "1]");
      if (u === "/bomb") {
        const zipped = zlib.gzipSync(Buffer.alloc(3_000_000, 32));
        return res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" }).end(zipped);
      }
      if (u === "/gz") return res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" }).end(zlib.gzipSync('{"ok":true}'));
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  const fake: Record<string, string[]> = { "good.test": ["127.0.0.1"], "evil.test": ["10.0.0.5"], "mixed.test": ["127.0.0.1", "10.0.0.5"] };
  const fetcher = (o: any = {}) =>
    makeGuardedFetcher({
      protocols: ["http:", "https:"],
      resolve: async (h) => (fake[h] ?? []).map((address) => ({ address, family: 4 })),
      isAllowedAddress: (a) => a === "127.0.0.1",
      cacheTtlMs: 0,
      ...o,
    });
  const at = (host: string, path: string) => `http://${host}:${port}${path}`;

  it("fetches a public address", async () => {
    expect(await fetcher()(at("good.test", "/data.json"))).toEqual({ text: '[{"a":1}]', contentType: "application/json" });
  });
  it("refuses a host that resolves to a private address", async () => {
    await expect(fetcher()(at("evil.test", "/data.json"))).rejects.toThrow(/cannot be fetched/);
  });
  it("refuses a host when ANY resolved address is private", async () => {
    await expect(fetcher()(at("mixed.test", "/data.json"))).rejects.toThrow(/cannot be fetched/);
  });
  it("re-checks every redirect", async () => {
    await expect(fetcher()(at("good.test", "/to-private"))).rejects.toThrow(/cannot be fetched/);
    await expect(fetcher()(at("good.test", "/to-literal"))).rejects.toThrow(/cannot be fetched/);
    await expect(fetcher()(at("good.test", "/to-ftp"))).rejects.toThrow(/cannot be fetched/);
  });
  it("stops a redirect loop", async () => {
    await expect(fetcher()(at("good.test", "/loop"))).rejects.toThrow(/redirected more than 3 times/);
  });
  it("times out", async () => {
    await expect(fetcher({ timeoutMs: 300 })(at("good.test", "/slow"))).rejects.toThrow(/timed out after 0 s|timed out/);
  });
  it("caps the body, and counts decoded bytes against a gzip bomb", async () => {
    await expect(fetcher({ maxBytes: 1_000_000 })(at("good.test", "/big"))).rejects.toThrow(/larger than 1 MB/);
    await expect(fetcher({ maxBytes: 1_000_000 })(at("good.test", "/bomb"))).rejects.toThrow(/larger than 1 MB/);
  });
  it("decodes gzip", async () => {
    expect((await fetcher()(at("good.test", "/gz"))).text).toBe('{"ok":true}');
  });
  it("reports a status", async () => {
    await expect(fetcher()(at("good.test", "/nope"))).rejects.toThrow(/the server answered 404/);
  });
});
