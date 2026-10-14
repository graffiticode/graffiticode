import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { installEgress, egressStatus } from "@graffiticode/l0000/egress";

// What the deploy CLI sets as NO_PROXY (packages/deploy/src/release.js).
const METADATA_ONLY = "169.254.169.254,metadata.google.internal";

// A CONNECT proxy standing in for the egress proxy: it tunnels to a listed
// name (resolved here to the local origin) and refuses anything else with
// the egress proxy's 403. It records every request it sees.
let proxy: http.Server;
let origin: http.Server;
let proxyUrl: string;
let originPort: number;
let seen: string[];
let originHits: string[] = [];
const LISTED = "listed.test";

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    originHits.push(req.url ?? "");
    res.end(`origin ${req.headers.host}`);
  });
  await new Promise<void>(r => origin.listen(0, "127.0.0.1", r));
  originPort = (origin.address() as AddressInfo).port;
  proxy = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(403, { "x-isolate01-refused": "unlisted" }).end();
  });
  proxy.on("connect", (req, socket: net.Socket) => {
    seen.push(`CONNECT ${req.url}`);
    const [host, port] = (req.url ?? "").split(":");
    if (host !== LISTED) {
      socket.end("HTTP/1.1 403 Forbidden\r\nx-isolate01-refused: unlisted\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const upstream = net.connect(Number(port), "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
  });
  await new Promise<void>(r => proxy.listen(0, "127.0.0.1", r));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise(r => proxy.close(r));
  await new Promise(r => origin.close(r));
});

const original = getGlobalDispatcher();
afterEach(() => {
  setGlobalDispatcher(original);
  installEgress({});
});

describe("installEgress", () => {
  test("with no proxy configured it leaves the dispatcher alone", () => {
    const status = installEgress({});
    expect(status.installed).toBe(false);
    expect(getGlobalDispatcher()).toBe(original);
    expect(egressStatus()).toEqual(status);
  });

  test("a listed host goes through the proxy", async () => {
    seen = [];
    const status = installEgress({ HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, NO_PROXY: METADATA_ONLY });
    expect(status.installed).toBe(true);
    expect(egressStatus()?.installed).toBe(true);
    const res = await fetch(`http://${LISTED}:${originPort}/x`);
    expect(await res.text()).toBe(`origin ${LISTED}:${originPort}`);
    expect(seen.some(s => s.includes(`${LISTED}:${originPort}`))).toBe(true);
  });

  test("an unlisted host is refused by the proxy, not reached directly", async () => {
    seen = [];
    originHits = [];
    installEgress({ HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, NO_PROXY: METADATA_ONLY });
    // The origin is reachable directly; the request must not get there.
    await expect(fetch(`http://127.0.0.1:${originPort}/direct`)).rejects.toThrow();
    expect(seen).toEqual([`CONNECT 127.0.0.1:${originPort}`]);
    expect(originHits).toEqual([]);
  });

  test("the metadata server bypasses the proxy", async () => {
    seen = [];
    installEgress({ HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, NO_PROXY: METADATA_ONLY });
    // Off Google there's no metadata server, so the request fails, but it
    // fails reaching the metadata name directly, never at the proxy.
    await fetch("http://metadata.google.internal/computeMetadata/v1/", { signal: AbortSignal.timeout(3000) }).catch(() => null);
    await fetch("http://169.254.169.254/computeMetadata/v1/", { signal: AbortSignal.timeout(500) }).catch(() => null);
    expect(seen.filter(s => /metadata\.google\.internal|169\.254\.169\.254/.test(s))).toEqual([]);
  });

  test("control: without the exclusion, a metadata request would reach the proxy", async () => {
    seen = [];
    installEgress({ HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, NO_PROXY: "" });
    await fetch("http://metadata.google.internal/computeMetadata/v1/", { signal: AbortSignal.timeout(3000) }).catch(() => null);
    expect(seen.some(s => s.includes("metadata.google.internal"))).toBe(true);
  });

  test("a NO_PROXY name bypasses the proxy and reaches its origin directly", async () => {
    seen = [];
    installEgress({ HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, NO_PROXY: `${METADATA_ONLY},127.0.0.1` });
    const res = await fetch(`http://127.0.0.1:${originPort}/direct`);
    expect(res.status).toBe(200);
    expect(seen).toEqual([]);
  });
});
