#!/usr/bin/env node
// AT-11, the network probe (ISOLATE-01; plan: ~/.claude/plans/isolate-01-compiler-egress.md,
// "AT-11"). Run as a Cloud Run job, as one compiler's account, on that compiler's subnet with
// its `network` config. It makes each check in the acceptance matrix and decides, for each,
// which control answered, never just "the request failed".
//
//   node scripts/at11/net.js --class compilers-default --subject l0176-run --config at11.json [--out dir]
//
// The config names the targets (see CONFIG below). A check whose target isn't configured is
// reported "not run", and a run with any check not run, or any unexpected outcome, fails.
// Some rows need evidence the job can't read: the proxy's access logs, the kernel's and the
// VPC firewall's rule hits, and the authoritative DNS log. Those rows are reported pending,
// the job's verdict is then "pending", and only the operator's collector (collect.js)
// decides them. Nothing here is run until rollout step 4 (deployment deferred).

import net, { isIP } from "node:net";
import tls from "node:tls";
import http2 from "node:http2";
import dgram from "node:dgram";
import { promises as dns } from "node:dns";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeEvidence, parseArgs } from "./lib.js";

// What a check can observe, as decided by `classify` (and, for Broker and auth, by their own
// deciders):
//   succeeds              the destination answered (any status not from the proxy)
//   refused:proxy         the proxy refused it (403 with x-isolate01-refused); `reason` says why
//   pending:network       the proxy couldn't open the upstream (a CONNECT answered 5xx). That
//                         alone proves nothing, since a destination that's down looks the same.
//                         It becomes refused:network only with the collector's evidence
//                         (`attributeNetwork`): the blocked address and the rule that fired
//   refused:network       (collector only) the address rules refused the actual destination
//   refused:firewall      nothing answered a direct connection
//   refused:cloudrun-iam  Cloud Run's own 403 page: the caller isn't an invoker
//   refused:broker        Broker's own JSON refusal; `reason` from its message
//   refused:auth          auth's own JSON refusal; `reason` from its message
//   nxdomain              the name doesn't exist (ENOTFOUND only: NODATA, SERVFAIL and the
//                         rest are errors)
//   error                 anything else, never a pass
export const OUTCOMES = ["succeeds", "refused:proxy", "pending:network", "refused:network", "refused:firewall", "refused:cloudrun-iam", "refused:broker", "refused:auth", "nxdomain", "error"];

// The proxy's refusal reasons: the x-isolate01-refused header, and `reason` on its log lines.
export const PROXY_REASONS = ["unlisted", "name", "ip-literal", "port", "host-mismatch", "trailing-dot"];

// The acceptance matrix, one row per check: its expected outcome per class kind. `default` is
// compilers-default; `lang` a compilers-<lang> class with reviewed external hosts; `open` is
// L0185 (D2). "residual" rows are accepted residuals: run and recorded, never pass/fail. "n/a"
// is not run for that kind. Rows with `broker` apply by the compiler's relationship to Broker
// (config.broker.relationship), not by its class: exactly one of them applies, the others are
// n/a.
export const MATRIX = [
  { id: "direct", title: "a direct connection, bypassing the proxy", default: "refused:firewall", lang: "refused:firewall", open: "refused:firewall" },
  { id: "listed", title: "a listed Graffiticode host, through the proxy", default: "succeeds", lang: "succeeds", open: "succeeds" },
  { id: "external", title: "a listed external host", default: "n/a", lang: "succeeds", open: "n/a" },
  { id: "unlisted", title: "an unlisted public host", default: "refused:proxy/unlisted", lang: "refused:proxy/unlisted", open: "succeeds" },
  { id: "learnosity", title: "Learnosity by host and alternate hosts", default: "refused:proxy/unlisted", lang: "refused:proxy/unlisted", open: "refused:proxy/name" },
  { id: "trailing-dot", title: "Learnosity and run.app names with a trailing dot", default: "refused:proxy", lang: "refused:proxy", open: "refused:proxy" },
  { id: "ip-literal", title: "Learnosity (or any host) by IPv4 and IPv6 literal", default: "refused:proxy/unlisted", lang: "refused:proxy/unlisted", open: "refused:proxy/ip-literal" },
  { id: "redirect", title: "a redirect chain ending at Learnosity or a private address", default: "refused:proxy/unlisted", lang: "refused:proxy/unlisted", open: "refused" },
  { id: "rebinding", title: "names resolving to metadata, 10.x, 127.0.0.1 or the load balancer, and a name whose answer changes", default: "refused:proxy/unlisted", lang: "refused:proxy/unlisted", open: "refused:network" },
  { id: "canary", title: "a public canary name we run, through the proxy (the control for refused:network)", default: "n/a", lang: "n/a", open: "succeeds" },
  { id: "run-app", title: "a run.app service by its URL (another project's; for L0185, Graffiticode's too)", default: "refused:proxy/unlisted", lang: "refused:proxy/unlisted", open: "refused:proxy/name" },
  { id: "frontend-ip", title: "a front-end IP with another Host", default: "refused:proxy/unlisted", lang: "refused:proxy/unlisted", open: "refused:proxy/ip-literal" },
  { id: "fronted", title: "a listed SNI with another Host or :authority, HTTP/1.1 and HTTP/2", default: "refused:proxy/host-mismatch", lang: "refused:proxy/host-mismatch", open: "refused:proxy/host-mismatch" },
  { id: "fronted-open", title: "fronting through an unlisted host", default: "n/a", lang: "n/a", open: "residual" },
  { id: "relay", title: "a relay in another project", default: "refused:proxy/unlisted", lang: "refused:proxy/unlisted", open: "residual" },
  { id: "dns-exfil", title: "DNS exfiltration through a domain we run (the server's log is checked)", default: "nxdomain", lang: "nxdomain", open: "nxdomain" },
  { id: "dns-direct", title: "DNS to a public resolver directly (UDP and TCP 53, DoT 853)", default: "refused:firewall", lang: "refused:firewall", open: "refused:firewall" },
  { id: "broker-unlisted", title: "Broker's execute, Broker not in the compiler's list", broker: "unlisted", default: "refused:proxy/unlisted", lang: "refused:proxy/unlisted", open: "refused:proxy/name" },
  { id: "broker-no-invoker", title: "Broker's execute, listed, without run.invoker", broker: "no-invoker", default: "refused:cloudrun-iam", lang: "refused:cloudrun-iam", open: "n/a" },
  { id: "broker-no-token", title: "Broker's execute with no execution token, by a listed invoker (L0176)", broker: "invoker", default: "refused:broker/missing-execution-token", lang: "refused:broker/missing-execution-token", open: "n/a" },
  { id: "act-as", title: "auth's /internal/act-as with the compiler's own ID token", default: "refused:auth/unknown-caller", lang: "refused:auth/unknown-caller", open: "refused:auth/unknown-caller" },
  { id: "admin", title: "the proxy's admin interface", default: "refused", lang: "refused", open: "refused" },
];

export const BROKER_RELATIONSHIPS = ["unlisted", "no-invoker", "invoker"];

// The config, per run. Every target is optional; a check without one is "not run".
//   proxy:        "http://10.8.0.2:3128"
//   kind:         "default" | "lang" | "open"
//   listed:       ["policy-....a.run.app"]           hosts this class lists
//   external:     ["storage.googleapis.com"]          (lang) its reviewed external hosts
//   unlisted:     ["example.com"]
//   learnosity:   ["items.learnosity.com", "data.learnosity.com", "eu.learnosity.com"]
//   trailingDot:  ["learnosity.com.", "items.learnosity.com.", "hello-xyz-uc.a.run.app."]
//   ipLiterals:   ["54.230.0.1", "[2600:9000::1]"]
//   redirect:     "https://<host we run>/to-learnosity"   (followed by hand; each hop rechecked)
//   rebinding:    ["meta.rebind.<domain we run>", "ten.rebind...", "lo.rebind...", "lb.rebind...", "flip.rebind..."]
//   canary:       "canary.<domain we run>"            (open) a public name, reachable through the proxy
//   runApp:       ["hello-xyz-uc.a.run.app"]          another project's service (and, for L0185, ours)
//   frontendIp:   "142.250.0.1"
//   fronting:     { sni: "<listed host>", host: "<another project's run.app host>" }
//   frontingOpen: { connect: "<unlisted fronted host>", host: "<another host>" }
//   relay:        "https://<relay we run in another project>/"
//   dnsExfil:     "<domain we run, its authoritative log kept>"
//   resolver:     "8.8.8.8"
//   publicIp:     "1.1.1.1"
//   broker:       { url, relationship: "unlisted" | "no-invoker" | "invoker", op?, payload? }
//   actAs:        { url: "https://auth.graffiticode.org", audience? }
//   admin:        { address: "10.8.0.2", port: 9901 }
//   timeoutMs:    5000
//   nonce:        set from AT11_NONCE by the collector; every probe id carries it

const DEFAULT_TIMEOUT = 5000;

// Decides what a single observation means.
//
// Only a direct connection's failure is the firewall's. A failure talking to the proxy (it's
// down, it reset, it timed out) is an error: a proxy that isn't there must never pass a row
// that expects a refusal. A CONNECT 5xx is only pending until the collector shows which
// address and rule refused it.
export function classify(observation) {
  if (observation.error === "nxdomain") return { outcome: "nxdomain" };
  if (observation.via === "direct" && ["timeout", "refused", "unreachable"].includes(observation.error)) return { outcome: "refused:firewall" };
  if (observation.error) return { outcome: "error", detail: observation.error };
  const reason = observation.headers?.["x-isolate01-refused"];
  if (observation.status === 403 && reason) {
    return PROXY_REASONS.includes(reason) ? { outcome: "refused:proxy", reason } : { outcome: "error", detail: `unknown refusal reason ${reason}` };
  }
  if (observation.stage === "connect" && observation.status >= 500) return { outcome: "pending:network", status: observation.status, probe: observation.probe };
  if (observation.stage === "connect" && observation.status !== 200) return { outcome: "error", detail: `CONNECT answered ${observation.status} without a refusal reason` };
  return { outcome: "succeeds", status: observation.status };
}

const jsonBody = observation => {
  try { return JSON.parse(observation.body ?? ""); } catch { return null; }
};
const reasonOf = message => String(message ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
// The JSON error body of @graffiticode/common/http: { status: "error", error: { code, message } }.
const serviceError = observation => {
  const body = jsonBody(observation);
  return body?.status === "error" && typeof body.error?.message === "string" ? body.error : null;
};

// Broker's answers. Its refusals are JSON; Cloud Run's IAM refusal is its own HTML page, never
// Broker's JSON. A 401 for a rejected caller (missing or invalid X-Caller-Identity) is a
// different refusal from a missing execution token, so the reason is always kept.
export function classifyBroker(observation) {
  const base = classify(observation);
  if (base.outcome !== "succeeds") return base;
  const error = serviceError(observation);
  if (observation.status === 403 && !error && /text\/html/i.test(observation.headers?.["content-type"] ?? "")) {
    return { outcome: "refused:cloudrun-iam", status: 403 };
  }
  if (error && [401, 403].includes(observation.status)) return { outcome: "refused:broker", status: observation.status, reason: reasonOf(error.message) };
  return { outcome: "error", status: observation.status, detail: `Broker answered ${observation.status} without a recognised refusal` };
}

// auth's answers to /internal/act-as: a caller outside ACT_AS_CALLERS gets 403 "unknown caller".
export function classifyAuth(observation) {
  const base = classify(observation);
  if (base.outcome !== "succeeds") return base;
  const error = serviceError(observation);
  if (error && [401, 403].includes(observation.status)) return { outcome: "refused:auth", status: observation.status, reason: reasonOf(error.message) };
  return { outcome: "error", status: observation.status, detail: `auth answered ${observation.status} without a recognised refusal` };
}

// Whether an observed outcome meets a matrix expectation.
export function meets(expected, got) {
  if (expected === "n/a" || expected === "residual") return true;
  if (expected === "refused") return got.outcome.startsWith("refused");
  if (expected.startsWith("status:")) return got.outcome === "succeeds" && got.status === Number(expected.slice(7));
  const [outcome, reason] = expected.split("/");
  return got.outcome === outcome && (!reason || got.reason === reason);
}

// Only ENOTFOUND is a genuine NXDOMAIN. NODATA (the name exists), SERVFAIL (a broken resolver
// or lockdown), REFUSED and timeouts are other answers, and never pass the exfiltration row.
const DNS_ERRORS = { ENODATA: "nodata", ESERVFAIL: "servfail", EREFUSED: "dns-refused", ECONNREFUSED: "dns-unreachable", ETIMEOUT: "dns-timeout", EBADRESP: "dns-badresp" };
export const dnsErrorKind = e => {
  const code = e?.code ?? "";
  if (code === "ENOTFOUND") return "nxdomain";
  return DNS_ERRORS[code] ?? `dns-${String(code || e?.message || e).toLowerCase()}`;
};

const errorKind = e => {
  const code = e?.code ?? "";
  if (code === "ETIMEDOUT" || e?.name === "TimeoutError" || /timeout/i.test(String(e?.message))) return "timeout";
  if (code === "ECONNREFUSED" || code === "ECONNRESET") return "refused";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "unreachable";
  return String(e?.message ?? e);
};

const parseHead = text => {
  const [statusLine, ...lines] = text.split("\r\n");
  return {
    status: Number(statusLine.split(" ")[1]),
    headers: Object.fromEntries(lines.map(l => [l.slice(0, l.indexOf(":")).trim().toLowerCase(), l.slice(l.indexOf(":") + 1).trim()])),
  };
};

// A raw CONNECT through the proxy: the proxy's status and headers, and the open socket on 200.
// `probe` goes on the CONNECT as x-isolate01-probe, so the proxy's log line carries it.
export function connectTunnel(proxyUrl, authority, timeoutMs = DEFAULT_TIMEOUT, probe = null) {
  const { hostname, port } = new URL(proxyUrl);
  return new Promise((resolve) => {
    const socket = net.connect(Number(port), hostname);
    const timer = setTimeout(() => { socket.destroy(); resolve({ via: "proxy", probe, error: "timeout" }); }, timeoutMs);
    let buffer = Buffer.alloc(0);
    socket.once("error", e => { clearTimeout(timer); resolve({ via: "proxy", probe, error: errorKind(e) }); });
    socket.on("connect", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${probe ? `x-isolate01-probe: ${probe}\r\n` : ""}\r\n`));
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      clearTimeout(timer);
      const { status, headers } = parseHead(buffer.subarray(0, end).toString());
      if (status !== 200) socket.destroy();
      resolve({ via: "proxy", stage: "connect", status, headers, probe, socket: status === 200 ? socket : null });
    };
    socket.on("data", onData);
  });
}

// One HTTPS request inside a tunnel: TLS with `sni`, then a request with `host` (HTTP/1.1) or
// `:authority` (HTTP/2). Trusts the proxy CA from NODE_EXTRA_CA_CERTS like the compilers do
// (or `ca`, in tests). With `body` it's sent, JSON-encoded unless a string, with its length.
// The response body is read, up to MAX_BODY bytes: Broker's and auth's refusals are told apart
// by it.
const MAX_BODY = 64 * 1024;
export function requestInTunnel(socket, { sni, host, path = "/", method = "GET", headers = {}, body, h2 = false, probe = null, ca, timeoutMs = DEFAULT_TIMEOUT }) {
  const payload = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const sent = {
    ...(payload && typeof body !== "string" ? { "content-type": "application/json" } : {}),
    ...headers,
    ...(probe ? { "x-isolate01-probe": probe } : {}),
  };
  return new Promise((resolve) => {
    const timer = setTimeout(() => { socket.destroy(); resolve({ via: "proxy", stage: "request", probe, error: "timeout" }); }, timeoutMs);
    let settled = false;
    const done = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ via: "proxy", stage: "request", probe, ...result });
    };
    const secure = tls.connect({ socket, servername: sni, ALPNProtocols: h2 ? ["h2"] : ["http/1.1"], ...(ca ? { ca } : {}) });
    secure.once("error", e => done({ error: errorKind(e) }));
    secure.once("secureConnect", () => {
      if (h2) {
        const session = http2.connect(`https://${sni}`, { createConnection: () => secure });
        session.once("error", e => done({ error: errorKind(e) }));
        const req = session.request({ ":method": method, ":path": path, ":authority": host, ...sent });
        req.once("response", h => {
          const chunks = [];
          let size = 0;
          req.on("data", c => { if (size < MAX_BODY) chunks.push(c); size += c.length; });
          req.once("end", () => {
            session.close();
            done({ status: Number(h[":status"]), headers: Object.fromEntries(Object.entries(h).filter(([k]) => !k.startsWith(":"))), body: Buffer.concat(chunks).subarray(0, MAX_BODY).toString() });
          });
        });
        req.end(payload ?? undefined);
        return;
      }
      const lines = { ...sent, ...(payload ? { "content-length": String(payload.length) } : {}) };
      secure.write(`${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n${Object.entries(lines).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`);
      if (payload) secure.write(payload);
      let buffer = Buffer.alloc(0);
      let head = null;
      const finish = () => {
        if (!head) return done({ error: "no response" });
        const rest = buffer.subarray(head.end + 4);
        const length = Number(head.headers["content-length"]);
        done({ status: head.status, headers: head.headers, body: (Number.isFinite(length) ? rest.subarray(0, length) : rest).subarray(0, MAX_BODY).toString() });
      };
      secure.on("data", chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!head) {
          const end = buffer.indexOf("\r\n\r\n");
          if (end === -1) return;
          head = { end, ...parseHead(buffer.subarray(0, end).toString()) };
        }
        const length = Number(head.headers["content-length"]);
        const have = buffer.length - head.end - 4;
        if ((Number.isFinite(length) && have >= length) || have >= MAX_BODY) {
          finish();
          secure.destroy();
        }
      });
      secure.once("end", finish);
      secure.once("close", finish);
    });
  });
}

// A probe id per request: the collector matches it to the proxy's access-log lines.
let probeCount = 0;
export const probeId = config => `${config.nonce ?? "run"}-${++probeCount}-${randomBytes(3).toString("hex")}`;

// CONNECT, and for a 200 an HTTPS request with the same name: the whole path a compiler takes.
// `method`, `headers` and `body` reach the inner request, and both carry one probe id.
export async function through(config, authority, { sni, host, path, h2, headers, method, body, ca } = {}) {
  const name = authority.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  const probe = probeId(config);
  const tunnel = await connectTunnel(config.proxy, authority, config.timeoutMs, probe);
  if (!tunnel.socket) return tunnel;
  return requestInTunnel(tunnel.socket, { sni: sni ?? name, host: host ?? name, path, h2, headers, method, body, probe, ca: ca ?? config.ca, timeoutMs: config.timeoutMs });
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
// `deps` lets tests replace the metadata server's ID tokens and the resolver.
export const CHECKS = {
  direct: async c => c.publicIp ? [await one(`${c.publicIp}:443`, directConnect(c.publicIp, 443, c.timeoutMs), asDirect)] : null,
  listed: async c => c.listed?.length ? Promise.all(c.listed.map(h => one(h, through(c, `${h}:443`)))) : null,
  external: async c => c.external?.length ? Promise.all(c.external.map(h => one(h, through(c, `${h}:443`)))) : null,
  unlisted: async c => c.unlisted?.length ? Promise.all(c.unlisted.map(h => one(h, through(c, `${h}:443`)))) : null,
  learnosity: async c => c.learnosity?.length ? Promise.all(c.learnosity.map(h => one(h, through(c, `${h}:443`)))) : null,
  "trailing-dot": async c => c.trailingDot?.length ? Promise.all(c.trailingDot.map(h => one(h, through(c, `${h}:443`)))) : null,
  "ip-literal": async c => c.ipLiterals?.length ? Promise.all(c.ipLiterals.map(ip => one(ip, through(c, `${ip}:443`)))) : null,
  redirect: async c => c.redirect ? [await followRedirects(c, c.redirect)] : null,
  // A name whose answer changes (flip.*: a public and a blocked address) is tried
  // several times. An attempt that reaches the public answer is allowed (landed:public,
  // confirmed against the proxy's log); one that reaches the blocked answer must be
  // refused there. Found in step 0: the public answer's TLS fails for our name, which
  // read as an error before.
  rebinding: async c => c.rebinding?.length
    ? (await Promise.all(c.rebinding.map(h => /^flip\./.test(h)
        ? Promise.all(Array.from({ length: c.flipAttempts ?? 6 }, () => one(h, through(c, `${h}:443`), classifyFlip)))
          .then(rs => rs.map(r => ({ ...r, flip: true })))
        : one(h, through(c, `${h}:443`)).then(r => [r])))).flat()
    : null,
  canary: async c => c.canary ? [await one(c.canary, through(c, `${c.canary}:443`))] : null,
  "run-app": async c => c.runApp?.length ? Promise.all(c.runApp.map(h => one(h, through(c, `${h}:443`)))) : null,
  "frontend-ip": async c => c.frontendIp ? [await one(c.frontendIp, through(c, `${c.frontendIp}:443`, { sni: c.fronting?.sni ?? "www.google.com", host: c.fronting?.host ?? "www.google.com" }))] : null,
  fronted: async c => c.fronting ? Promise.all([false, true].map(h2 => one(`${c.fronting.sni} as ${c.fronting.host}${h2 ? " (h2)" : ""}`, through(c, `${c.fronting.sni}:443`, { sni: c.fronting.sni, host: c.fronting.host, h2 })))) : null,
  "fronted-open": async c => c.frontingOpen ? [await one(`${c.frontingOpen.connect} as ${c.frontingOpen.host}`, through(c, `${c.frontingOpen.connect}:443`, { host: c.frontingOpen.host }))] : null,
  relay: async c => c.relay ? [await one(c.relay, through(c, `${new URL(c.relay).hostname}:443`, { path: new URL(c.relay).pathname }))] : null,
  "dns-exfil": async (c, { resolve4 = dns.resolve4 } = {}) => {
    if (!c.dnsExfil) return null;
    const label = `at11-${randomBytes(8).toString("hex")}`;
    const name = `${label}.${c.dnsExfil}`;
    const queriedAt = new Date().toISOString();
    const observation = await resolve4(name).then(() => ({ via: "dns", status: 0 }), e => ({ via: "dns", error: dnsErrorKind(e), code: e?.code }));
    const result = observation.error === "nxdomain" ? { outcome: "nxdomain" } : observation.error ? { outcome: "error", detail: observation.error } : { outcome: "succeeds", status: 0 };
    return [{ target: name, observation, result, logCheck: { name, label, queriedAt } }];
  },
  "dns-direct": async c => c.resolver
    ? [
        await one(`${c.resolver} udp/53`, directUdpDns(c.resolver, c.timeoutMs), asDirect),
        await one(`${c.resolver} tcp/53`, directConnect(c.resolver, 53, c.timeoutMs), asDirect),
        await one(`${c.resolver} tcp/853`, directConnect(c.resolver, 853, c.timeoutMs), asDirect),
      ]
    : null,
  "broker-unlisted": async (c, deps) => c.broker?.relationship === "unlisted" ? [await brokerExecute(c, deps)] : null,
  "broker-no-invoker": async (c, deps) => c.broker?.relationship === "no-invoker" ? [await brokerExecute(c, deps)] : null,
  "broker-no-token": async (c, deps) => c.broker?.relationship === "invoker" ? [await brokerExecute(c, deps)] : null,
  "act-as": async (c, deps) => c.actAs ? [await actAs(c, deps)] : null,
  admin: async c => c.admin
    ? [
        await one(`${c.admin.address}:${c.admin.port} direct`, directConnect(c.admin.address, c.admin.port, c.timeoutMs), asDirect),
        await one(`127.0.0.1:${c.admin.port} via proxy`, through(c, `127.0.0.1:${c.admin.port}`)),
      ]
    : null,
};

// For a flip attempt, a tunnel that opened (the CONNECT succeeded) and then failed TLS reached
// a public answer that doesn't serve our name. That's allowed, pending the proxy's log.
export function classifyFlip(observation) {
  if (observation.stage === "request" && observation.error) return { outcome: "landed:public", probe: observation.probe, detail: observation.error };
  return classify(observation);
}

async function one(target, pending, decide = classify) {
  const observation = await pending;
  const { socket, ...recorded } = observation;
  socket?.destroy?.();
  return { target, observation: recorded, result: decide(observation) };
}

// Broker's execute as a compiler makes it, minus the execution token: POST /v1/execute with
// { op, payload }, the compiler's ID token as Cloud Run's invoker token
// (X-Serverless-Authorization) and as the caller (X-Caller-Identity), and no Authorization,
// which is where the execution token would go.
export function brokerRequest(c, idToken) {
  const url = new URL(c.broker.url);
  return {
    authority: `${url.hostname}:${url.port || 443}`,
    path: "/v1/execute",
    method: "POST",
    headers: { "x-serverless-authorization": `Bearer ${idToken}`, "x-caller-identity": idToken },
    body: { op: c.broker.op ?? "at11.probe", payload: c.broker.payload ?? {} },
  };
}

const noToken = (target, e) => ({ target, observation: { error: `no ID token: ${e.message}` }, result: { outcome: "error", detail: `no ID token: ${e.message}` } });

async function brokerExecute(c, { idToken = metadataIdToken } = {}) {
  const target = `${c.broker.url}/v1/execute`;
  let token;
  try { token = await idToken(c.broker.url); } catch (e) { return noToken(target, e); }
  const { authority, ...request } = brokerRequest(c, token);
  return one(target, through(c, authority, request), classifyBroker);
}

// auth's act-as as a compromised compiler would try it: its own ID token as the caller.
async function actAs(c, { idToken = metadataIdToken } = {}) {
  const url = new URL(c.actAs.url);
  const target = `${c.actAs.url}/internal/act-as`;
  let token;
  try { token = await idToken(c.actAs.audience ?? c.actAs.url); } catch (e) { return noToken(target, e); }
  return one(target, through(c, `${url.hostname}:${url.port || 443}`, {
    path: "/internal/act-as",
    method: "POST",
    headers: { "x-caller-identity": token },
    body: { purpose: "generation", uid: "at11", subject: "at11", grant: "at11" },
  }), classifyAuth);
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

// The state of one row from its results:
//   passed / failed    decided here
//   pending-log        dns-exfil: every lookup was a genuine NXDOMAIN, and only the
//                      authoritative log (the collector) can show no query got out
//   pending-evidence   a refused:network expectation whose results are pending:network: the
//                      collector decides each from the logs (`attributeNetwork`)
export function rowState(row, expected, results) {
  if (expected === "residual") return "residual";
  if (row.id === "dns-exfil") return results.every(r => r.result.outcome === "nxdomain") ? "pending-log" : "failed";
  if (expected === "refused:network") {
    const network = r => ["pending:network", "refused:network"].includes(r.result.outcome);
    const landed = r => r.flip && ["landed:public", "landed:public-confirmed"].includes(r.result.outcome);
    // A flip attempt may land on its public answer (confirmed by the proxy's log) or be
    // refused on its blocked one. It isn't required to reach the blocked answer: Envoy's
    // forward proxy caches the first resolution, so within a run all six landed on the
    // public answer (step 0). The single-answer names prove the network refuses each
    // blocked address.
    if (!results.every(r => network(r) || landed(r))) return "failed";
    const pending = results.some(r => ["pending:network", "landed:public"].includes(r.result.outcome));
    return pending ? "pending-evidence" : "passed";
  }
  return results.every(r => meets(expected, r.result)) ? "passed" : "failed";
}

// A set of rows passes only when every applicable row passed (or is a residual). It's pending
// when the only rows left are waiting on the collector.
export function verdictOf(rows) {
  if (rows.some(r => !["passed", "residual", "n/a", "pending-log", "pending-evidence"].includes(r.state))) return "failed";
  if (rows.some(r => r.state === "pending-log" || r.state === "pending-evidence")) return "pending";
  return "passed";
}

// Runs every row for this class kind. A row is passed, failed, residual, not run, n/a, or
// pending on the collector.
export async function runNet(config, checks = CHECKS, deps = {}) {
  const kind = config.kind;
  if (!["default", "lang", "open"].includes(kind)) throw new Error("config.kind must be default, lang or open");
  if (config.broker && !BROKER_RELATIONSHIPS.includes(config.broker.relationship)) {
    throw new Error(`config.broker.relationship must be one of ${BROKER_RELATIONSHIPS.join(", ")}`);
  }
  if (kind === "open" && config.broker && config.broker.relationship !== "unlisted") {
    throw new Error("L0185's open class refuses every run.app name, so Broker can't be listed for it");
  }
  const rows = [];
  for (const row of MATRIX) {
    const expected = row.broker && config.broker && config.broker.relationship !== row.broker ? "n/a" : row[kind];
    if (expected === "n/a") {
      rows.push({ id: row.id, title: row.title, expected, state: "n/a" });
      continue;
    }
    const results = await checks[row.id](config, deps);
    if (!results) {
      rows.push({ id: row.id, title: row.title, expected, state: "not run" });
      continue;
    }
    rows.push({ id: row.id, title: row.title, expected, state: rowState(row, expected, results), results });
  }
  const verdict = verdictOf(rows);
  return { probe: "net", kind, verdict, passed: verdict === "passed", rows };
}

// --- the evidence the collector brings: the proxy's logs, the rule hits, the DNS log ---

// Where the network refuses a new connection from the proxy (ENVOY_OUT and the VPC firewall),
// besides the compiler subnets, the proxy subnet and the load balancer.
export const BLOCKED_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "0.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "224.0.0.0/4", "240.0.0.0/4", "199.36.153.8/30", "199.36.153.4/30"];

const ipv4 = a => a.split(".").reduce((n, o) => n * 256 + Number(o), 0);
export function inCidr(address, cidr) {
  const [base, bits] = cidr.split("/");
  if (isIP(address) !== 4 || isIP(base) !== 4) return false;
  const size = 2 ** (32 - Number(bits ?? 32));
  return Math.floor(ipv4(address) / size) === Math.floor(ipv4(base) / size);
}

export function blockedRanges(blocked = {}) {
  return [
    ...BLOCKED_RANGES,
    ...(blocked.compilerSubnets ?? []),
    ...(blocked.proxySubnet ? [blocked.proxySubnet] : []),
    ...(blocked.loadBalancer ? [`${blocked.loadBalancer}/32`] : []),
  ];
}

// The address on an access-log line's upstream field ("10.0.0.5:443" or "10.0.0.5").
const addressOf = s => String(s ?? "").replace(/:\d+$/, "");
const dstPattern = a => new RegExp(`\\bDST=${a.replace(/\./g, "\\.")}(\\s|$)`);

// Decides one pending:network result from the evidence. It's refused:network only when all of
// these hold:
//   - the proxy's access line for this probe names the upstream address it tried, and every
//     such address is inside a blocked range;
//   - the rule that refused it fired: an ENVOY_OUT `ISOLATE01-REJECT` kernel line, or a VPC
//     firewall-log hit, for that destination address;
//   - a reachable canary succeeded through the same proxy in the same run.
// An unreachable public destination gives the same CONNECT failure but no rule hit and an
// address outside the blocked ranges, so it never passes.
export function attributeNetwork(result, { accessLines = [], kernelLines = [], firewallHits = [], canaryPassed = false, blocked } = {}) {
  if (result.outcome !== "pending:network") return result;
  if (!result.probe) return { outcome: "error", detail: "a connect failure without a probe id can't be matched to its log line" };
  if (!canaryPassed) return { outcome: "error", detail: "no reachable canary in this run, so a connect failure proves nothing" };
  const lines = accessLines.filter(l => l.probe === result.probe && l.isolate01 === "egress");
  if (!lines.length) return { outcome: "error", detail: `no proxy access line for probe ${result.probe}` };
  const addresses = [...new Set(lines.map(l => addressOf(l.upstream_host || l.upstream)).filter(a => a && a !== "-"))];
  if (!addresses.length) return { outcome: "error", detail: "the access line names no upstream address" };
  const ranges = blockedRanges(blocked);
  const unblocked = addresses.filter(a => !ranges.some(r => inCidr(a, r)));
  if (unblocked.length) return { outcome: "error", detail: `upstream ${unblocked.join(", ")} isn't in a blocked range, so the failure isn't the address rules'` };
  const missing = addresses.filter(a =>
    !kernelLines.some(k => /ISOLATE01-REJECT \S+/.test(k) && dstPattern(a).test(k)) &&
    !firewallHits.some(f => (f.connection?.dest_ip ?? f.dest_ip) === a));
  if (missing.length) return { outcome: "error", detail: `no ISOLATE01-REJECT or firewall-log hit for ${missing.join(", ")}` };
  return { outcome: "refused:network", addresses, probe: result.probe };
}

// A flip attempt that reached its public answer counts only if the proxy's own access line
// shows an upstream address outside every blocked range. Landing on a blocked address is
// the failure this row exists to catch.
export function confirmLanding(result, { accessLines = [], blocked } = {}) {
  if (result.outcome !== "landed:public") return result;
  if (!result.probe) return { outcome: "error", detail: "a landing without a probe id can't be matched to its log line" };
  const lines = accessLines.filter(l => l.probe === result.probe && l.isolate01 === "egress");
  const addresses = [...new Set(lines.map(l => addressOf(l.upstream_host || l.upstream)).filter(a => a && a !== "-"))];
  if (!addresses.length) return { outcome: "error", detail: `no upstream address logged for probe ${result.probe}` };
  const ranges = blockedRanges(blocked);
  const inBlocked = addresses.filter(a => ranges.some(r => inCidr(a, r)));
  if (inBlocked.length) return { outcome: "error", detail: `a flip attempt reached ${inBlocked.join(", ")}, a blocked address` };
  return { outcome: "landed:public-confirmed", addresses, probe: result.probe };
}

// A proxy refusal counts only if the proxy's own access line for that probe says it refused,
// for the same reason. A 403 with the header but no such line (or another reason) is an error.
export function confirmRefusal(result, probe, accessLines = []) {
  if (result.outcome !== "refused:proxy") return result;
  if (!probe) return { outcome: "error", detail: "a proxy refusal without a probe id can't be matched to its log line" };
  const lines = accessLines.filter(l => l.probe === probe);
  if (!lines.length) return { outcome: "error", detail: `no proxy access line for probe ${probe}` };
  if (!lines.some(l => l.decision === "refuse" && l.reason === result.reason)) {
    return { outcome: "error", detail: `the proxy's log for probe ${probe} doesn't refuse it for ${result.reason}` };
  }
  return result;
}

// Settles a net result with the collector's evidence: each proxy refusal confirmed by its log
// line, and each pending row decided by attributeNetwork. Row states are re-derived.
export function settleNetwork(netResult, evidence = {}) {
  const canaryPassed = netResult.rows.find(r => r.id === "canary")?.state === "passed";
  const rows = netResult.rows.map(row => {
    if (!row.results || ["n/a", "not run", "residual"].includes(row.state) || row.id === "dns-exfil") return row;
    const results = row.results.map(r => {
      let result = r.result;
      // A redirect chain's refusal is its last hop's.
      const probe = r.observation?.probe ?? r.observation?.hops?.at(-1)?.observation?.probe;
      if (result.outcome === "refused:proxy") result = confirmRefusal(result, probe, evidence.accessLines);
      if (result.outcome === "pending:network") result = attributeNetwork(result, { ...evidence, canaryPassed });
      if (result.outcome === "landed:public") result = confirmLanding(result, evidence);
      return result === r.result ? r : { ...r, result };
    });
    return { ...row, results, state: rowState(row, row.expected, results) };
  });
  return { ...netResult, rows };
}

// Decides the DNS exfiltration row from the authoritative server's log. It passes only when:
//   - every compiler lookup was a genuine NXDOMAIN;
//   - the collector's own control label, resolved from outside the compiler VPC and sent
//     before the log was fetched, is in the log, so the log would have recorded a leak;
//   - the log covers the window from the compiler's first query to the control;
//   - none of the compiler's labels is in it.
// Without the control the row is void: an empty or broken log proves nothing.
export function judgeDnsRow(row, log, control) {
  if (!row?.results?.length) return { state: "not run", why: "no dns-exfil results" };
  if (!row.results.every(r => r.result.outcome === "nxdomain")) return { state: "failed", why: "a lookup wasn't a genuine NXDOMAIN" };
  if (!control?.label || !control.sentAt) return { state: "void", why: "no outside control query was sent" };
  if (!log || typeof log.text !== "string" || !log.text.trim()) return { state: "void", why: "the authoritative log is empty" };
  if (!log.fetchedAt || log.fetchedAt <= control.sentAt) return { state: "void", why: "the log was fetched before the control query was sent" };
  // Resolvers randomise the case of names they send on (Google's does, 0x20
  // encoding: `PRObe-4A7E…`), so the log is matched without case.
  const text = log.text.toLowerCase();
  const logged = label => text.includes(String(label).toLowerCase());
  if (!logged(control.label)) return { state: "void", why: "the control label isn't in the log, so it proves nothing" };
  const first = row.results.map(r => r.logCheck.queriedAt).sort()[0];
  if (!log.from || !log.to || log.from > first || log.to < control.sentAt) return { state: "void", why: "the log doesn't cover the run's window" };
  const leaked = row.results.filter(r => logged(r.logCheck.label)).map(r => r.target);
  return leaked.length ? { state: "failed", why: `queries reached the authoritative server: ${leaked.join(", ")}`, leaked } : { state: "passed", leaked: [] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ["--class", "--subject", "--config", "--out"]);
  if (!args["--class"] || !args["--config"]) throw new Error("usage: net.js --class <class> [--subject <account>] --config <at11.json> [--out dir]");
  const config = { ...JSON.parse(await readFile(args["--config"], "utf8")), nonce: process.env.AT11_NONCE ?? null };
  const result = {
    probe: "net",
    class: args["--class"],
    subject: args["--subject"] ?? null,
    nonce: config.nonce,
    execution: process.env.CLOUD_RUN_EXECUTION ?? null,
    at: new Date().toISOString(),
    ...(await runNet(config)),
  };
  const file = await writeEvidence(args["--out"], args["--class"], "net", result);
  // A job's filesystem doesn't outlive it: the evidence also goes to the log, one line.
  console.log(`AT11-EVIDENCE ${JSON.stringify(result)}`);
  for (const r of result.rows) console.log(`${r.state.padEnd(16)} ${r.id}: ${r.title} (expected ${r.expected})`);
  console.log(`${result.verdict.toUpperCase()} (only the collector's verdict counts); evidence: ${file}`);
  process.exit(result.verdict === "failed" ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
