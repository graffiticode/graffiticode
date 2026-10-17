import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
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

// HTTPS through the proxy, trusting the proxy's CA from NODE_EXTRA_CA_CERTS. Node reads that
// variable only at startup, so each case runs in a child process that imports the built helper
// (npm test builds first). The CA and the listed host's certificate are made with openssl for
// this run; the origin serves that certificate, standing in for the proxy's TLS termination.
describe("HTTPS through the proxy with the mounted CA", () => {
  let dir: string;
  let tlsOrigin: https.Server;
  let tlsPort: number;
  const run = promisify(execFile);
  const EGRESS = pathToFileURL(resolve("dist/egress.js")).href;

  const openssl = (...args: string[]) => {
    try {
      execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
    } catch (err: any) {
      throw new Error(`openssl ${args[0]} failed (the test needs the openssl CLI): ${err?.stderr ?? err?.message}`, { cause: err });
    }
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "l0000-egress-ca-"));
    const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
    openssl("req", "-x509", ...ec, "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=isolate01 test CA",
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign");
    openssl("req", ...ec, "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", `/CN=${LISTED}`);
    writeFileSync(join(dir, "leaf.ext"), `subjectAltName=DNS:${LISTED}\nextendedKeyUsage=serverAuth\n`);
    openssl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
      "-out", "leaf.pem", "-days", "2", "-extfile", "leaf.ext");
    tlsOrigin = https.createServer(
      { key: readFileSync(join(dir, "leaf.key")), cert: readFileSync(join(dir, "leaf.pem")) },
      (req, res) => res.end(`tls origin ${req.headers.host}`),
    );
    await new Promise<void>(r => tlsOrigin.listen(0, "127.0.0.1", r));
    tlsPort = (tlsOrigin.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise(r => tlsOrigin.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  // A fresh node that installs the helper on import, then fetches `url`.
  const child = async (url: string, extra: Record<string, string>) => {
    const script = `await import(${JSON.stringify(EGRESS)});
      try { const r = await fetch(${JSON.stringify(url)}); console.log(JSON.stringify({ status: r.status, body: await r.text() })); }
      catch (e) { console.log(JSON.stringify({ error: String(e?.cause?.code ?? e?.cause?.message ?? e?.message) })); }`;
    const env = { PATH: process.env.PATH ?? "", HTTPS_PROXY: proxyUrl, NO_PROXY: METADATA_ONLY, ...extra };
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], { env, timeout: 15000 });
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  };

  test("a listed https host is reached through the proxy, trusting the mounted CA", async () => {
    seen = [];
    const got = await child(`https://${LISTED}:${tlsPort}/x`, { NODE_EXTRA_CA_CERTS: join(dir, "ca.pem") });
    expect(got).toEqual({ status: 200, body: `tls origin ${LISTED}:${tlsPort}` });
    expect(seen).toEqual([`CONNECT ${LISTED}:${tlsPort}`]);
  });

  test("control: without the mounted CA the certificate isn't trusted", async () => {
    seen = [];
    const got = await child(`https://${LISTED}:${tlsPort}/x`, {});
    expect(got.status).toBeUndefined();
    expect(got.error).toMatch(/CERT|certificate|SELF_SIGNED|UNABLE_TO/i);
    expect(seen).toEqual([`CONNECT ${LISTED}:${tlsPort}`]);
  });

  test("an unlisted https host is refused at the proxy", async () => {
    seen = [];
    const got = await child(`https://unlisted.test:${tlsPort}/x`, { NODE_EXTRA_CA_CERTS: join(dir, "ca.pem") });
    expect(got.status).toBeUndefined();
    expect(seen).toEqual([`CONNECT unlisted.test:${tlsPort}`]);
  });
});
