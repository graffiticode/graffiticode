// ISOLATE-01 rollout step 0: the prototype checks AT-11's matrix doesn't make
// (plan: ~/.claude/plans/isolate-01-compiler-egress.md, step 0's "must show"):
//   - a client's X-Forwarded-For (and similar) and a PROXY protocol header don't
//     change its class;
//   - one class can't reach another class's listed host;
//   - HTTP/2 through a terminated host;
//   - a long transfer (open class) and a long-lived connection (terminated) complete.
// Run in the probe image, as each probe's job:
//   node extras.mjs --config /config/probe-<class>.json
// One line, AT11-EXTRAS <json>, with every check and its outcome.

import net from "node:net";
import tls from "node:tls";
import http2 from "node:http2";
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const config = JSON.parse(await readFile(args[args.indexOf("--config") + 1], "utf8"));
const { hostname: proxyHost, port: proxyPort } = new URL(config.proxy);
const TIMEOUT = 15000;

// A raw CONNECT, with whatever prefix and headers the check needs: the status line and headers.
function rawConnect(authority, { prefix = "", headers = {} } = {}) {
  return new Promise(resolve => {
    const socket = net.connect(Number(proxyPort), proxyHost);
    const timer = setTimeout(() => { socket.destroy(); resolve({ error: "timeout" }); }, TIMEOUT);
    let buf = "";
    socket.once("error", e => { clearTimeout(timer); resolve({ error: e.code ?? String(e) }); });
    socket.on("connect", () => socket.write(prefix + `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n` +
      Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n"));
    socket.on("data", d => {
      buf += d.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      clearTimeout(timer);
      const [line, ...rest] = buf.slice(0, end).split("\r\n");
      const h = Object.fromEntries(rest.map(l => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
      resolve({ status: Number(line.split(" ")[1]), refused: h["x-isolate01-refused"] ?? null, socket });
    });
    socket.on("close", () => { clearTimeout(timer); resolve({ closed: true, partial: buf.slice(0, 80) }); });
  });
}

const done = r => { r?.socket?.destroy(); const { socket, ...rest } = r ?? {}; return rest; };

// Opens TLS through a CONNECT tunnel (the CA bundle is trusted through NODE_EXTRA_CA_CERTS).
async function tunnelTls(authority, alpn) {
  const t = await rawConnect(authority);
  if (t.status !== 200) return { error: `CONNECT ${t.status ?? t.error ?? "closed"}`, refused: t.refused };
  const name = authority.replace(/:\d+$/, "");
  return new Promise(resolve => {
    const s = tls.connect({ socket: t.socket, servername: name, ALPNProtocols: alpn });
    s.once("secureConnect", () => resolve({ socket: s, alpn: s.alpnProtocol }));
    s.once("error", e => resolve({ error: e.message }));
  });
}

const checks = {};
const kind = config.kind;
const otherClass = { default: "10.8.20.10", lang: "10.8.20.10", open: "10.8.16.10" }[kind];
const unlistedHere = kind === "open" ? "www.googleapis.com:443" : "example.com:443";

// Spoofing: a header naming another class's address, and a PROXY protocol line claiming one,
// must not change the class. In a strict class the target stays refused as unlisted (or the
// connection is rejected outright); in the open class, a googleapis name stays refused by name.
checks["spoof-headers"] = done(await rawConnect(unlistedHere, { headers: { "X-Forwarded-For": otherClass, "X-Real-IP": otherClass, "X-Envoy-External-Address": otherClass, Forwarded: `for=${otherClass}` } }));
checks["spoof-headers"].ok = checks["spoof-headers"].status === 403;
checks["spoof-proxy-protocol"] = done(await rawConnect(unlistedHere, { prefix: `PROXY TCP4 ${otherClass} 10.8.0.2 40000 3128\r\n` }));
checks["spoof-proxy-protocol"].ok = checks["spoof-proxy-protocol"].status !== 200;

// Cross-class: the default class can't reach the ext class's listed external host.
if (kind === "default") {
  checks["cross-class"] = done(await rawConnect("www.googleapis.com:443"));
  checks["cross-class"].ok = checks["cross-class"].status === 403 && checks["cross-class"].refused === "unlisted";
}

// HTTP/2 through a terminated, listed host.
{
  const t = await tunnelTls("api.graffiticode.org:443", ["h2"]);
  if (!t.socket) checks.h2 = { ok: false, ...t };
  else {
    checks.h2 = await new Promise(resolve => {
      const session = http2.connect("https://api.graffiticode.org", { createConnection: () => t.socket });
      session.on("error", e => resolve({ ok: false, error: e.message }));
      const req = session.request({ ":path": "/", ":authority": "api.graffiticode.org" });
      req.on("response", h => { req.resume(); req.on("end", () => { session.close(); resolve({ ok: h[":status"] < 500 && !h["x-isolate01-refused"], status: h[":status"], alpn: t.alpn }); }); });
      req.on("error", e => resolve({ ok: false, error: e.message }));
      req.end();
    });
  }
}

// A long-lived connection through a terminated host: several requests over one TLS connection
// for about a minute, so idle and stream timeouts show up.
{
  const t = await tunnelTls("api.graffiticode.org:443", ["http/1.1"]);
  if (!t.socket) checks["long-lived"] = { ok: false, ...t };
  else {
    const statuses = [];
    const started = Date.now();
    let err = null;
    for (let i = 0; i < 6 && !err; i++) {
      if (i) await new Promise(resolve => setTimeout(resolve, 10000));
      statuses.push(await new Promise(resolve => {
        let buf = "";
        const onData = d => {
          buf += d.toString("latin1");
          const m = /^HTTP\/1\.1 (\d+)/.exec(buf);
          const len = /content-length: (\d+)/i.exec(buf);
          const end = buf.indexOf("\r\n\r\n");
          if (m && end !== -1 && (!len || buf.length - end - 4 >= Number(len[1]))) { t.socket.off("data", onData); resolve(Number(m[1])); }
        };
        t.socket.on("data", onData);
        t.socket.once("close", () => { err = "closed"; resolve(null); });
        t.socket.write("GET / HTTP/1.1\r\nHost: api.graffiticode.org\r\nConnection: keep-alive\r\n\r\n");
      }));
    }
    t.socket.destroy();
    checks["long-lived"] = { ok: !err && statuses.every(s => s && s < 500), statuses, seconds: Math.round((Date.now() - started) / 1000), error: err };
  }
}

// A long transfer through the open class: 50 MB from a public host, counted to the last byte.
if (kind === "open") {
  const bytes = 50_000_000;
  const t = await tunnelTls("speed.cloudflare.com:443", ["http/1.1"]);
  if (!t.socket) checks["long-transfer"] = { ok: false, ...t };
  else {
    checks["long-transfer"] = await new Promise(resolve => {
      const started = Date.now();
      let got = 0;
      let header = true;
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => { t.socket.destroy(); resolve({ ok: false, error: "timeout", got }); }, 180000);
      t.socket.on("data", d => {
        if (header) {
          buf = Buffer.concat([buf, d]);
          const end = buf.indexOf("\r\n\r\n");
          if (end === -1) return;
          header = false;
          got += buf.length - end - 4;
        } else got += d.length;
      });
      t.socket.on("close", () => { clearTimeout(timer); resolve({ ok: got === bytes, got, bytes, seconds: Math.round((Date.now() - started) / 1000) }); });
      t.socket.write(`GET /__down?bytes=${bytes} HTTP/1.1\r\nHost: speed.cloudflare.com\r\nConnection: close\r\n\r\n`);
    });
  }
}

const passed = Object.values(checks).every(c => c.ok);
console.log(`AT11-EXTRAS ${JSON.stringify({ kind, nonce: process.env.AT11_NONCE ?? null, passed, checks })}`);
process.exit(passed ? 0 : 1);
