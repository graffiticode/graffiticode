#!/usr/bin/env node
// AT-11, the network probe (ISOLATE-01; plan: ~/.claude/plans/isolate-01-compiler-egress.md,
// "AT-11"). Run as a Cloud Run job, as one compiler's account, on that compiler's subnet with
// its `network` config. It makes each check in the acceptance matrix and decides, for each,
// which control answered, never just "the request failed".
//
//   node scripts/at11/net.js --class compilers-default --config at11.json [--out dir]
//
// The config names the targets (see CONFIG below). A check whose target isn't configured is
// reported "not run", and a run with any check not run, or any unexpected outcome, fails.
// Nothing here is run until rollout step 4 (deployment deferred).

import net from "node:net";
import tls from "node:tls";
import http2 from "node:http2";
import dgram from "node:dgram";
import { promises as dns } from "node:dns";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeEvidence, parseArgs } from "./lib.js";

// What a check can observe, as decided by `classify`:
//   succeeds        the destination answered (any status not from the proxy)
//   refused:proxy   the proxy refused it (403 with x-isolate01-refused); `reason` says why
//   refused:network the proxy couldn't open it (a CONNECT answered 5xx: the address rules)
//   refused:firewall nothing answered a direct connection
//   nxdomain        the name didn't resolve
//   status:<n>      an HTTP status from the destination, for checks that expect one
export const OUTCOMES = ["succeeds", "refused:proxy", "refused:network", "refused:firewall", "nxdomain"];

// The acceptance matrix, one row per check: its expected outcome per class kind. `default` is
// compilers-default; `lang` a compilers-<lang> class with reviewed external hosts; `open` is
// L0185 (D2). "residual" rows are accepted residuals: run and recorded, never pass/fail. "n/a"
// is not run for that kind.
export const MATRIX = [
  { id: "direct", title: "a direct connection, bypassing the proxy", default: "refused:firewall", lang: "refused:firewall", open: "refused:firewall" },
  { id: "listed", title: "a listed Graffiticode host, through the proxy", default: "succeeds", lang: "succeeds", open: "succeeds" },
  { id: "external", title: "a listed external host", default: "n/a", lang: "succeeds", open: "n/a" },
  { id: "unlisted", title: "an unlisted public host", default: "refused:proxy/unlisted", lang: "refused:proxy/unlisted", open: "succeeds" },
  { id: "learnosity", title: "Learnosity by host and alternate hosts", default: "refused:proxy/unlisted", lang: "refused:proxy/unlisted", open: "refused:proxy/name" },
  { id: "ip-literal", title: "Learnosity (or any host) by IPv4 and IPv6 literal", default: "refused:proxy/unlisted", lang: "refused:proxy/unlisted", open: "refused:proxy/ip-literal" },
  { id: "redirect", title: "a redirect chain ending at Learnosity or a private address", default: "refused:proxy/unlisted", lang: "refused:proxy/unlisted", open: "refused" },
  { id: "rebinding", title: "names resolving to metadata, 10.x, 127.0.0.1 or the load balancer, and a name whose answer changes", default: "refused:proxy/unlisted", lang: "refused:proxy/unlisted", open: "refused:network" },
  { id: "run-app", title: "another project's run.app service by its URL", default: "refused:proxy/unlisted", lang: "refused:proxy/unlisted", open: "refused:proxy/name" },
  { id: "frontend-ip", title: "a front-end IP with another Host", default: "refused:proxy/unlisted", lang: "refused:proxy/unlisted", open: "refused:proxy/ip-literal" },
  { id: "fronted", title: "a listed SNI with another Host or :authority, HTTP/1.1 and HTTP/2", default: "refused:proxy/host-mismatch", lang: "refused:proxy/host-mismatch", open: "refused:proxy/host-mismatch" },
  { id: "fronted-open", title: "fronting through an unlisted host", default: "n/a", lang: "n/a", open: "residual" },
  { id: "relay", title: "a relay in another project", default: "refused:proxy/unlisted", lang: "refused:proxy/unlisted", open: "residual" },
  { id: "dns-exfil", title: "DNS exfiltration through a domain we run (the server's log is checked)", default: "nxdomain", lang: "nxdomain", open: "nxdomain" },
  { id: "dns-direct", title: "DNS to a public resolver directly (UDP and TCP 53, DoT 853)", default: "refused:firewall", lang: "refused:firewall", open: "refused:firewall" },
  { id: "broker-unlisted", title: "Broker's execute, Broker not in the class's list", default: "refused:proxy/unlisted", lang: "refused:proxy/unlisted", open: "refused:proxy/name" },
  { id: "broker-no-invoker", title: "Broker's execute, listed, without run.invoker", default: "status:403", lang: "status:403", open: "n/a" },
  { id: "broker-no-token", title: "Broker's execute with no execution token, by an authorized caller (L0176)", default: "status:401", lang: "n/a", open: "n/a" },
  { id: "admin", title: "the proxy's admin interface", default: "refused", lang: "refused", open: "refused" },
];

// The config, per run. Every target is optional; a check without one is "not run".
//   proxy:        "http://10.8.0.2:3128"
//   kind:         "default" | "lang" | "open"
//   listed:       ["policy-....a.run.app"]           hosts this class lists
//   external:     ["storage.googleapis.com"]          (lang) its reviewed external hosts
//   unlisted:     ["example.com"]
//   learnosity:   ["items.learnosity.com", "data.learnosity.com", "eu.learnosity.com"]
//   ipLiterals:   ["54.230.0.1", "[2600:9000::1]"]
//   redirect:     "https://<host we run>/to-learnosity"   (followed by hand; each hop rechecked)
//   rebinding:    ["meta.rebind.<domain we run>", "ten.rebind...", "lo.rebind...", "lb.rebind...", "flip.rebind..."]
//   runApp:       ["hello-xyz-uc.a.run.app"]          another project's service
//   frontendIp:   "142.250.0.1"
//   fronting:     { sni: "<listed host>", host: "<another project's run.app host>" }
//   frontingOpen: { connect: "<unlisted fronted host>", host: "<another host>" }
//   relay:        "https://<relay we run in another project>/"
//   dnsExfil:     "<domain we run, its authoritative log kept>"
//   resolver:     "8.8.8.8"
//   publicIp:     "1.1.1.1"
//   broker:       { url, listed: bool, invoker: bool, idToken?: true }
//   admin:        { address: "10.8.0.2", port: 9901 }
//   timeoutMs:    5000

const DEFAULT_TIMEOUT = 5000;

// Decides what a single observation means.
export function classify(observation) {
  if (observation.error === "nxdomain") return { outcome: "nxdomain" };
  if (observation.error === "timeout" || observation.error === "refused" || observation.error === "unreachable") {
    return { outcome: observation.via === "proxy" ? "refused:network" : "refused:firewall" };
  }
  if (observation.error) return { outcome: "error", detail: observation.error };
  const reason = observation.headers?.["x-isolate01-refused"];
  if (observation.status === 403 && reason) return { outcome: "refused:proxy", reason };
  if (observation.stage === "connect" && observation.status >= 500) return { outcome: "refused:network", status: observation.status };
  if (observation.stage === "connect" && observation.status !== 200) return { outcome: "error", detail: `CONNECT answered ${observation.status} without a refusal reason` };
  return { outcome: "succeeds", status: observation.status };
}

// Whether an observed outcome meets a matrix expectation.
export function meets(expected, got) {
  if (expected === "n/a" || expected === "residual") return true;
  if (expected === "refused") return got.outcome.startsWith("refused");
  if (expected.startsWith("status:")) return got.outcome === "succeeds" && got.status === Number(expected.slice(7));
  const [outcome, reason] = expected.split("/");
  return got.outcome === outcome && (!reason || got.reason === reason);
}

const errorKind = e => {
  const code = e?.code ?? "";
  if (code === "ENOTFOUND" || code === "ENODATA" || code === "ESERVFAIL") return "nxdomain";
  if (code === "ETIMEDOUT" || e?.name === "TimeoutError" || /timeout/i.test(String(e?.message))) return "timeout";
  if (code === "ECONNREFUSED" || code === "ECONNRESET") return "refused";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "unreachable";
  return String(e?.message ?? e);
};

// A raw CONNECT through the proxy: the proxy's status and headers, and the open socket on 200.
export function connectTunnel(proxyUrl, authority, timeoutMs = DEFAULT_TIMEOUT) {
  const { hostname, port } = new URL(proxyUrl);
  return new Promise((resolve) => {
    const socket = net.connect(Number(port), hostname);
    const timer = setTimeout(() => { socket.destroy(); resolve({ via: "proxy", error: "timeout" }); }, timeoutMs);
    let buffer = Buffer.alloc(0);
    socket.once("error", e => { clearTimeout(timer); resolve({ via: "proxy", error: errorKind(e) }); });
    socket.on("connect", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      clearTimeout(timer);
      const [statusLine, ...lines] = buffer.slice(0, end).toString().split("\r\n");
      const status = Number(statusLine.split(" ")[1]);
      const headers = Object.fromEntries(lines.map(l => [l.slice(0, l.indexOf(":")).trim().toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
      if (status !== 200) socket.destroy();
      resolve({ via: "proxy", stage: "connect", status, headers, socket: status === 200 ? socket : null });
    };
    socket.on("data", onData);
  });
}

// One HTTPS request inside a tunnel: TLS with `sni`, then a request with `host` (HTTP/1.1) or
// `:authority` (HTTP/2). Trusts the proxy CA from NODE_EXTRA_CA_CERTS like the compilers do.
export function requestInTunnel(socket, { sni, host, path = "/", method = "GET", headers = {}, h2 = false, timeoutMs = DEFAULT_TIMEOUT }) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { socket.destroy(); resolve({ via: "proxy", stage: "request", error: "timeout" }); }, timeoutMs);
    const done = result => { clearTimeout(timer); resolve({ via: "proxy", stage: "request", ...result }); };
    const secure = tls.connect({ socket, servername: sni, ALPNProtocols: h2 ? ["h2"] : ["http/1.1"] });
    secure.once("error", e => done({ error: errorKind(e) }));
    secure.once("secureConnect", () => {
      if (h2) {
        const session = http2.connect(`https://${sni}`, { createConnection: () => secure });
        session.once("error", e => done({ error: errorKind(e) }));
        const req = session.request({ ":method": method, ":path": path, ":authority": host, ...headers });
        req.once("response", h => {
          req.resume();
          req.once("end", () => session.close());
          done({ status: Number(h[":status"]), headers: Object.fromEntries(Object.entries(h).filter(([k]) => !k.startsWith(":"))) });
        });
        req.end();
        return;
      }
      secure.write(`${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`);
      let buffer = Buffer.alloc(0);
      secure.on("data", chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const [statusLine, ...lines] = buffer.slice(0, end).toString().split("\r\n");
        secure.destroy();
        done({ status: Number(statusLine.split(" ")[1]), headers: Object.fromEntries(lines.map(l => [l.slice(0, l.indexOf(":")).trim().toLowerCase(), l.slice(l.indexOf(":") + 1).trim()])) });
      });
    });
  });
}

// CONNECT, and for a 200 an HTTPS request with the same name: the whole path a compiler takes.
async function through(config, authority, { sni, host, path, h2, headers } = {}) {
  const name = authority.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  const tunnel = await connectTunnel(config.proxy, authority, config.timeoutMs);
  if (!tunnel.socket) return tunnel;
  return requestInTunnel(tunnel.socket, { sni: sni ?? name, host: host ?? name, path, h2, headers, timeoutMs: config.timeoutMs });
}

function directConnect(address, port, timeoutMs = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    const socket = net.connect(port, address);
    const timer = setTimeout(() => { socket.destroy(); resolve({ via: "direct", error: "timeout" }); }, timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve({ via: "direct", status: 0, connected: true }); });
    socket.once("error", e => { clearTimeout(timer); resolve({ via: "direct", error: errorKind(e) }); });
  });
}

// A DNS query for example.com straight to a resolver, over UDP: refused if no answer comes.
function directUdpDns(resolver, timeoutMs = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const query = Buffer.from("abcd01000001000000000000076578616d706c6503636f6d0000010001", "hex");
    const timer = setTimeout(() => { socket.close(); resolve({ via: "direct", error: "timeout" }); }, timeoutMs);
    socket.once("message", () => { clearTimeout(timer); socket.close(); resolve({ via: "direct", status: 0, connected: true }); });
    socket.once("error", e => { clearTimeout(timer); socket.close(); resolve({ via: "direct", error: errorKind(e) }); });
    socket.send(query, 53, resolver);
  });
}

const asDirect = o => (o.connected ? { outcome: "succeeds", status: 0 } : classify(o));

// The checks. Each returns a list of { target, observation, result } (several targets per row).
export const CHECKS = {
  direct: async c => c.publicIp ? [await one(`${c.publicIp}:443`, directConnect(c.publicIp, 443, c.timeoutMs), asDirect)] : null,
  listed: async c => c.listed?.length ? Promise.all(c.listed.map(h => one(h, through(c, `${h}:443`)))) : null,
  external: async c => c.external?.length ? Promise.all(c.external.map(h => one(h, through(c, `${h}:443`)))) : null,
  unlisted: async c => c.unlisted?.length ? Promise.all(c.unlisted.map(h => one(h, through(c, `${h}:443`)))) : null,
  learnosity: async c => c.learnosity?.length ? Promise.all(c.learnosity.map(h => one(h, through(c, `${h}:443`)))) : null,
  "ip-literal": async c => c.ipLiterals?.length ? Promise.all(c.ipLiterals.map(ip => one(ip, through(c, `${ip}:443`)))) : null,
  redirect: async c => c.redirect ? [await followRedirects(c, c.redirect)] : null,
  rebinding: async c => c.rebinding?.length ? Promise.all(c.rebinding.map(h => one(h, through(c, `${h}:443`)))) : null,
  "run-app": async c => c.runApp?.length ? Promise.all(c.runApp.map(h => one(h, through(c, `${h}:443`)))) : null,
  "frontend-ip": async c => c.frontendIp ? [await one(c.frontendIp, through(c, `${c.frontendIp}:443`, { sni: c.fronting?.sni ?? "www.google.com", host: c.fronting?.host ?? "www.google.com" }))] : null,
  fronted: async c => c.fronting ? Promise.all([false, true].map(h2 => one(`${c.fronting.sni} as ${c.fronting.host}${h2 ? " (h2)" : ""}`, through(c, `${c.fronting.sni}:443`, { sni: c.fronting.sni, host: c.fronting.host, h2 })))) : null,
  "fronted-open": async c => c.frontingOpen ? [await one(`${c.frontingOpen.connect} as ${c.frontingOpen.host}`, through(c, `${c.frontingOpen.connect}:443`, { host: c.frontingOpen.host }))] : null,
  relay: async c => c.relay ? [await one(c.relay, through(c, `${new URL(c.relay).hostname}:443`, { path: new URL(c.relay).pathname }))] : null,
  "dns-exfil": async c => {
    if (!c.dnsExfil) return null;
    const label = `at11-${randomBytes(8).toString("hex")}`;
    const name = `${label}.${c.dnsExfil}`;
    const observation = await dns.resolve4(name).then(() => ({ status: 0 }), e => ({ error: errorKind(e) }));
    return [{ target: name, observation, result: classify(observation), logCheck: { name, label } }];
  },
  "dns-direct": async c => c.resolver
    ? [
        await one(`${c.resolver} udp/53`, directUdpDns(c.resolver, c.timeoutMs), asDirect),
        await one(`${c.resolver} tcp/53`, directConnect(c.resolver, 53, c.timeoutMs), asDirect),
        await one(`${c.resolver} tcp/853`, directConnect(c.resolver, 853, c.timeoutMs), asDirect),
      ]
    : null,
  "broker-unlisted": async c => c.broker && !c.broker.listed ? [await one(c.broker.url, through(c, `${new URL(c.broker.url).hostname}:443`, { path: "/v1/execute", method: "POST" }))] : null,
  "broker-no-invoker": async c => c.broker?.listed && !c.broker.invoker ? [await brokerExecute(c)] : null,
  "broker-no-token": async c => c.broker?.listed && c.broker.invoker ? [await brokerExecute(c)] : null,
  admin: async c => c.admin
    ? [
        await one(`${c.admin.address}:${c.admin.port} direct`, directConnect(c.admin.address, c.admin.port, c.timeoutMs), asDirect),
        await one(`127.0.0.1:${c.admin.port} via proxy`, through(c, `127.0.0.1:${c.admin.port}`)),
      ]
    : null,
};

async function one(target, pending, decide = classify) {
  const observation = await pending;
  const { socket, ...recorded } = observation;
  socket?.destroy?.();
  return { target, observation: recorded, result: decide(observation) };
}

// Broker's execute with the compiler's own ID token (for Cloud Run) and no execution token.
async function brokerExecute(c) {
  const host = new URL(c.broker.url).hostname;
  const token = await metadataIdToken(c.broker.url).catch(() => null);
  return one(`${c.broker.url}/v1/execute`, through(c, `${host}:443`, {
    path: "/v1/execute",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }));
}

async function metadataIdToken(audience) {
  const res = await fetch(`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`, { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) throw new Error(`metadata ${res.status}`);
  return res.text();
}

// Follows a redirect chain by hand, every hop through the proxy, the first refusal ending it.
async function followRedirects(c, start, max = 5) {
  let url = new URL(start);
  const hops = [];
  for (let i = 0; i < max; i++) {
    const observation = await through(c, `${url.hostname}:443`, { path: url.pathname + url.search });
    const { socket, ...recorded } = observation;
    hops.push({ url: url.toString(), observation: recorded });
    const result = classify(observation);
    const location = observation.headers?.location;
    if (result.outcome !== "succeeds" || !(observation.status >= 300 && observation.status < 400 && location)) {
      return { target: start, observation: { hops }, result };
    }
    url = new URL(location, url);
  }
  return { target: start, observation: { hops }, result: { outcome: "error", detail: "too many redirects" } };
}

// Runs every row for this class kind. A row is passed, failed, residual, not run, or n/a.
export async function runNet(config, checks = CHECKS) {
  const kind = config.kind;
  if (!["default", "lang", "open"].includes(kind)) throw new Error("config.kind must be default, lang or open");
  const rows = [];
  for (const row of MATRIX) {
    const expected = row[kind];
    if (expected === "n/a") {
      rows.push({ id: row.id, title: row.title, expected, state: "n/a" });
      continue;
    }
    const results = await checks[row.id](config);
    if (!results) {
      rows.push({ id: row.id, title: row.title, expected, state: "not run" });
      continue;
    }
    const state = expected === "residual" ? "residual" : results.every(r => meets(expected, r.result)) ? "passed" : "failed";
    rows.push({ id: row.id, title: row.title, expected, state, results });
  }
  const passed = rows.every(r => ["passed", "residual", "n/a"].includes(r.state));
  return { probe: "net", kind, passed, rows };
}

// The DNS exfiltration row passes only once the authoritative server's log shows no query for
// any of its names (evidence step: `node scripts/at11/net.js --dns-log <log> <evidence.json>`).
export function checkDnsLog(evidence, logText) {
  const row = evidence.rows.find(r => r.id === "dns-exfil");
  if (!row?.results) return { checked: false };
  const leaked = row.results.filter(r => logText.includes(r.logCheck.label)).map(r => r.target);
  return { checked: true, leaked, passed: leaked.length === 0 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ["--class", "--config", "--out", "--dns-log"]);
  if (args["--dns-log"]) {
    const [evidenceFile] = args._;
    const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
    const result = checkDnsLog(evidence, await readFile(args["--dns-log"], "utf8"));
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.passed ? 0 : 1);
  }
  if (!args["--class"] || !args["--config"]) throw new Error("usage: net.js --class <class> --config <at11.json> [--out dir] | --dns-log <log> <evidence.json>");
  const config = JSON.parse(await readFile(args["--config"], "utf8"));
  const result = { class: args["--class"], at: new Date().toISOString(), ...(await runNet(config)) };
  const file = await writeEvidence(args["--out"], args["--class"], "net", result);
  // A job's filesystem doesn't outlive it: the evidence also goes to the log, one line.
  console.log(`AT11-EVIDENCE ${JSON.stringify(result)}`);
  for (const r of result.rows) console.log(`${r.state.padEnd(8)} ${r.id}: ${r.title} (expected ${r.expected})`);
  console.log(`${result.passed ? "PASSED" : "FAILED"}; evidence: ${file}`);
  process.exit(result.passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
