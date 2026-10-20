/* eslint camelcase: "off" -- Envoy's configuration API is snake_case. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fullMatch, outcome, routeRequest } from "./route-sim.js";
import {
  BLOCKED, EXTENSIONS, IP_LITERAL, LOG_FIELDS, ORDER_AWK, PAIRS_AWK, REJECT_PREFIX, TCP_LOG_FIELDS, TRAILING_DOT,
  buildModel, cloudInit, envoyConfig, envoyOutRules, extensionsUsed, inputRules, load, rejectRules, terminatedHosts,
  logicalUserData,
} from "../generate.js";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIXTURES = path.join(HERE, "fixtures");
const fixture = () => load({ deploy: path.join(FIXTURES, "deploy.json"), classes: path.join(FIXTURES, "classes.json") });
const json = async name => JSON.parse(await readFile(path.join(FIXTURES, name), "utf8"));

// UPDATE_GOLDEN=1 node --test rewrites the golden files; review the diff.
async function golden(name, actual) {
  const file = path.join(FIXTURES, name);
  if (process.env.UPDATE_GOLDEN) await writeFile(file, actual);
  assert.equal(actual, await readFile(file, "utf8"), `${name} differs from its golden file (UPDATE_GOLDEN=1 to accept)`);
}

test("the three-class fixture generates the golden Envoy config and cloud-init", async () => {
  const model = await fixture();
  const envoy = envoyConfig(model);
  await golden("envoy.golden.json", JSON.stringify(envoy, null, 2) + "\n");
  // Golden in its logical form: gzip's bytes differ between zlib versions (CI and a laptop).
  await golden("cloud-init.golden.yaml", logicalUserData(cloudInit(model, envoy)));
});

test("classes get exactly their own services' hosts", async () => {
  const model = await fixture();
  assert.deepEqual(model.classes["compilers-default"].hosts, ["broker-sja7fatcta-uc.a.run.app", "policy-sja7fatcta-uc.a.run.app"]);
  assert.deepEqual(model.classes["compilers-l0013"].hosts, ["storage.googleapis.com"]);
  assert.deepEqual(model.classes["compilers-l0185"].hosts, ["api.graffiticode.org"]);
  assert.equal(model.classes["compilers-l0185"].open, true);
  assert.deepEqual(terminatedHosts(model), ["api.graffiticode.org", "broker-sja7fatcta-uc.a.run.app", "policy-sja7fatcta-uc.a.run.app", "storage.googleapis.com"]);
});

test("the class comes only from the connection's direct source, with no default chain", async () => {
  const envoy = envoyConfig(await fixture());
  const outer = envoy.static_resources.listeners.find(l => l.name === "egress");
  assert.equal(outer.default_filter_chain, undefined);
  assert.equal(outer.listener_filters, undefined, "no PROXY protocol or other listener filter on the outer listener");
  assert.deepEqual(outer.filter_chains.map(c => [c.name, c.filter_chain_match]), [
    ["compilers-default", { direct_source_prefix_ranges: [{ address_prefix: "10.8.16.0", prefix_len: 22 }] }],
    ["compilers-l0013", { direct_source_prefix_ranges: [{ address_prefix: "10.8.24.0", prefix_len: 24 }] }],
    ["compilers-l0185", { direct_source_prefix_ranges: [{ address_prefix: "10.8.20.0", prefix_len: 22 }] }],
  ]);
  for (const chain of outer.filter_chains) {
    const h = chain.filters[0].typed_config;
    assert.equal(h.use_remote_address, true);
    assert.equal(h.xff_num_trusted_hops, 0);
  }
});

test("no class's internal listener or routes hold another class's hosts", async () => {
  const model = await fixture();
  const envoy = envoyConfig(model);
  const listeners = envoy.static_resources.listeners;
  for (const cls of Object.values(model.classes)) {
    const inner = listeners.find(l => l.name === `terminate-${cls.name}`);
    const sni = inner.filter_chains.flatMap(c => c.filter_chain_match.server_names);
    assert.deepEqual(sni, cls.hosts, `${cls.name}'s internal listener`);
    assert.equal(inner.default_filter_chain, undefined);
    const outer = listeners.find(l => l.name === "egress").filter_chains.find(c => c.name === cls.name);
    const vhosts = outer.filters[0].typed_config.route_config.virtual_hosts;
    const tunnels = vhosts.flatMap(v => v.routes).filter(r => r.route?.cluster?.startsWith("terminate-"));
    const clusters = tunnels.map(r => envoy.static_resources.clusters.find(c => c.name === r.route.cluster));
    assert.ok(clusters.every(c => c.load_assignment.endpoints[0].lb_endpoints.every(e => e.endpoint.address.envoy_internal_address.server_listener_name === `terminate-${cls.name}`)),
      `${cls.name} tunnels only to its own listener`);
    assert.deepEqual(clusters.map(c => c.load_assignment.endpoints[0].lb_endpoints[0].metadata.filter_metadata.isolate01.target).sort(), cls.hosts);
  }
});

test("each listed host's CONNECT reaches its own internal endpoint, carrying that host as host metadata (A2)", async () => {
  const model = await fixture();
  const envoy = envoyConfig(model);
  const { listeners, clusters } = envoy.static_resources;
  for (const cls of Object.values(model.classes)) {
    const hcm = listeners.find(l => l.name === "egress").filter_chains.find(c => c.name === cls.name).filters[0].typed_config;
    const inner = listeners.find(l => l.name === `terminate-${cls.name}`);
    for (const host of cls.hosts) {
      const { cluster } = outcome(routeRequest(hcm, { method: "CONNECT", authority: `${host}:443` }));
      assert.equal(cluster, `terminate-${cls.name}-${host.replace(/\./g, "-")}`);
      const c = clusters.find(x => x.name === cluster);
      const [lb] = c.load_assignment.endpoints[0].lb_endpoints;
      assert.equal(c.load_assignment.endpoints[0].lb_endpoints.length, 1, "one endpoint: one target");
      assert.equal(lb.endpoint.address.envoy_internal_address.server_listener_name, inner.name);
      assert.deepEqual(lb.metadata, { filter_metadata: { isolate01: { target: host } } });
      assert.deepEqual(c.transport_socket.typed_config.passthrough_metadata, [{ kind: { host: {} }, name: "isolate01" }]);
      // The inner chain for that SNI requires exactly that metadata.
      const chain = inner.filter_chains.find(fc => fc.filter_chain_match.server_names.includes(host));
      const [principal] = chain.filters[0].typed_config.rules.policies["connect-target-is-sni"].principals;
      assert.deepEqual(principal.sourced_metadata, { metadata_matcher: { filter: "isolate01", path: [{ key: "target" }], value: { string_match: { exact: host } } }, metadata_source: "DYNAMIC" });
      assert.equal(principal.metadata, undefined, "not the deprecated Principal.metadata");
    }
  }
  // No route kind anywhere, and no route metadata left over.
  const text = JSON.stringify(envoy);
  assert.doesNotMatch(text, /"route":\{\}/);
  assert.ok(!listeners.find(l => l.name === "egress").filter_chains.some(fc => JSON.stringify(fc).includes("filter_metadata")));
});

test("each terminating chain requires the CONNECT target to equal its SNI, and its Host to match", async () => {
  const envoy = envoyConfig(await fixture());
  const inner = envoy.static_resources.listeners.filter(l => l.internal_listener);
  for (const chain of inner.flatMap(l => l.filter_chains)) {
    const [host] = chain.filter_chain_match.server_names;
    const [rbac, http] = chain.filters;
    assert.equal(rbac.name, "envoy.filters.network.rbac");
    assert.equal(rbac.typed_config.rules.action, "ALLOW");
    const [principal] = rbac.typed_config.rules.policies["connect-target-is-sni"].principals;
    assert.deepEqual(principal.sourced_metadata.metadata_matcher.value, { string_match: { exact: host } });
    const vhosts = http.typed_config.route_config.virtual_hosts;
    assert.deepEqual(vhosts[0].domains, [host, `${host}:443`]);
    assert.equal(vhosts[1].routes[0].direct_response.status, 403, "any other Host is refused");
  }
  const clusters = envoy.static_resources.clusters.filter(c => c.name.startsWith("terminate-"));
  for (const c of clusters) {
    assert.deepEqual(c.transport_socket.typed_config.passthrough_metadata, [{ kind: { host: {} }, name: "isolate01" }]);
  }
});

test("only the open class forwards unlisted names, refusing denied names, IP literals and non-443 CONNECTs", async () => {
  const envoy = envoyConfig(await fixture());
  const outer = envoy.static_resources.listeners.find(l => l.name === "egress");
  const routesOf = name => outer.filter_chains.find(c => c.name === name).filters[0].typed_config.route_config.virtual_hosts;
  for (const name of ["compilers-default", "compilers-l0013"]) {
    const catchAll = routesOf(name).find(v => v.domains.includes("*"));
    assert.ok(catchAll.routes.every(r => r.direct_response?.status === 403), `${name} refuses anything unlisted`);
  }
  const open = routesOf("compilers-l0185");
  const denied = open.find(v => v.name === "open-refused-names");
  for (const d of ["learnosity.com:443", "*.learnosity.com:443", "*.run.app:443", "*.internal:443", "*.googleapis.com:80"]) {
    assert.ok(denied.domains.includes(d), d);
  }
  const catchAll = open.find(v => v.name === "open");
  const ipRoutes = catchAll.routes.filter(r => r.response_headers_to_add?.[0]?.header.value === "ip-literal");
  assert.equal(ipRoutes.length, 2);
  assert.ok(ipRoutes.every(r => r.direct_response.status === 403));
  const regex = ipRoutes[0].match.headers[0].string_match.safe_regex.regex;
  for (const literal of ["93.184.216.34:443", "10.0.0.1", "[2001:db8::1]:443", "[::ffff:169.254.169.254]:80"]) assert.ok(fullMatch(regex, literal), literal);
  assert.ok(!fullMatch(regex, "example.com:443"));
  // The listed Graffiticode host is still terminated, not forwarded, for L0185.
  assert.equal(open[0].routes[0].route.cluster, "terminate-compilers-l0185-api-graffiticode-org");
  const dfp = envoy.static_resources.clusters.find(c => c.name === "open-forward").cluster_type.typed_config.dns_cache_config;
  assert.equal(dfp.dns_lookup_family, "V4_ONLY");
});

test("upstreams resolve IPv4 only through the fixed resolvers and verify the listed name", async () => {
  const envoy = envoyConfig(await fixture());
  for (const c of envoy.static_resources.clusters.filter(c => c.name.startsWith("upstream-"))) {
    assert.equal(c.dns_lookup_family, "V4_ONLY");
    assert.deepEqual(c.typed_dns_resolver_config.typed_config.resolvers.map(r => r.socket_address.address), ["8.8.8.8", "8.8.4.4"]);
    const tls = c.transport_socket.typed_config;
    const host = c.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address.address;
    assert.equal(tls.sni, host);
    assert.deepEqual(tls.common_tls_context.validation_context.match_typed_subject_alt_names, [{ san_type: "DNS", matcher: { exact: host } }]);
  }
});

test("the admin interface is on loopback only", async () => {
  const envoy = envoyConfig(await fixture());
  assert.equal(envoy.admin.address.socket_address.address, "127.0.0.1");
});

test("only reviewed stable extensions appear; the SNI dynamic forward proxy never does", async () => {
  const used = extensionsUsed(envoyConfig(await fixture()));
  assert.deepEqual([...used].filter(n => !EXTENSIONS.has(n)), []);
  assert.ok(!EXTENSIONS.has("envoy.filters.network.sni_dynamic_forward_proxy"));
  assert.ok(used.has("envoy.filters.http.dynamic_forward_proxy"));
});

test("ENVOY_OUT accepts return traffic first, then rejects new internal connections, then allows, then drops", async () => {
  const model = await fixture();
  const rules = envoyOutRules(model);
  assert.equal(rules[0], "-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT");
  assert.equal(rules.at(-1), "-j DROP");
  const kinds = rules.map(r => r === rules[0] ? "established" : / -j (REJECT$|LOG )/.test(r) ? "reject" : / -j ACCEPT$/.test(r) ? "accept" : "drop");
  const order = kinds.filter((k, i) => k !== kinds[i - 1]);
  assert.deepEqual(order, ["established", "reject", "accept", "drop"]);
  const rejected = rules.filter(r => r.endsWith("-j REJECT")).map(r => r.match(/-d (\S+)/)[1]);
  for (const c of [...BLOCKED, "169.254.0.0/16", "10.8.16.0/22", "10.8.24.0/24", "10.8.20.0/22", "10.8.0.0/27", "10.8.0.2/32"]) assert.ok(rejected.includes(c), c);
  assert.ok(rules.filter(r => r.includes("NEW")).every(r => r.includes("--ctstate NEW")), "every filter after the first is on NEW connections");
  assert.ok(rules.includes("-m conntrack --ctstate NEW -p udp -d 8.8.8.8/32 --dport 53 -j ACCEPT"));
});

test("INPUT takes only compilers on 3128 and health checks on 3129, then its own DROP (A9)", async () => {
  const model = await fixture();
  const rules = inputRules(model);
  assert.equal(rules.at(-1), "-j DROP");
  assert.ok(rules.includes("-p tcp -s 35.191.0.0/16 --dport 3129 -j ACCEPT"));
  assert.ok(rules.includes("-p tcp -s 10.8.16.0/22 --dport 3128 -j ACCEPT"));
  assert.ok(!rules.some(r => r.includes("--dport 9901")), "the admin port is never reachable but on lo");
  const config = JSON.parse(cloudInit(model, envoyConfig(model)).slice("#cloud-config\n".length));
  const check = config.write_files.find(f => f.path === "/etc/egress-proxy/firewall-check.sh").content;
  assert.match(check, /EGRESS_IN does not end in its own DROP/);
  for (const r of rules) assert.ok(check.includes(`iptables -w -C EGRESS_IN ${r}`), r);
});

test("cloud-init runs Envoy on the host network as its own UID, behind the firewall self-check", async () => {
  const model = await fixture();
  const text = cloudInit(model, envoyConfig(model));
  assert.ok(text.startsWith("#cloud-config\n"));
  const config = JSON.parse(text.slice("#cloud-config\n".length));
  const file = p => config.write_files.find(f => f.path === p).content;
  const envoyUnit = file("/etc/systemd/system/egress-envoy.service");
  assert.match(envoyUnit, /--network host/);
  assert.match(envoyUnit, /--user 10101:10101 --cap-drop ALL/);
  assert.match(envoyUnit, /--read-only/);
  assert.match(envoyUnit, /ExecStartPre=\/bin\/bash \/etc\/egress-proxy\/firewall-check\.sh/);
  assert.match(envoyUnit, /envoyproxy\/envoy@sha256:0{64}/);
  assert.doesNotMatch(envoyUnit, /--network(?! host)|-p \d/);
  const firewall = file("/etc/egress-proxy/firewall.sh");
  const appended = firewall.split("\n").filter(l => l.startsWith("iptables -w -A ENVOY_OUT ")).map(l => l.slice("iptables -w -A ENVOY_OUT ".length));
  assert.deepEqual(appended, envoyOutRules(model));
  assert.match(firewall, /-I OUTPUT 1 -m owner --uid-owner 10101 -j ENVOY_OUT/);
  assert.match(firewall, /ip6tables -w .*--uid-owner 10101 -j DROP/);
  const check = file("/etc/egress-proxy/firewall-check.sh");
  assert.ok(check.includes(envoyOutRules(model)[0]));
  assert.match(file("/etc/egress-proxy/fetch-certs.sh"), /chown -R 10101:10101/);
});

test("cloud-init refuses unpinned images", async () => {
  const classes = await json("classes.json");
  const deploy = await json("deploy.json");
  for (const proxy of [{ envoyImage: null }, { envoyImage: "envoyproxy/envoy:v1.36" }, { cosImage: "cos-stable" }, { cosImage: null }]) {
    const model = buildModel(deploy, { ...classes, proxy: { ...classes.proxy, ...proxy } });
    assert.throws(() => cloudInit(model, envoyConfig(model)), /pinned|one COS image/);
  }
});

test("deploy.json entries must name a known class, the compiler network and the proxy's address", async () => {
  const classes = await json("classes.json");
  const net = { network: "compilers", subnet: "compilers-default", tags: ["c"], proxy: "http://10.8.0.2:3128", ca: {}, allow: [] };
  assert.throws(() => buildModel({ services: { a: { runtimeServiceAccount: "a-run@graffiticode.iam.gserviceaccount.com", network: { ...net, subnet: "nope" } } } }, classes), /not a class/);
  assert.throws(() => buildModel({ services: { a: { runtimeServiceAccount: "a-run@graffiticode.iam.gserviceaccount.com", network: { ...net, network: "default" } } } }, classes), /must be compilers/);
  assert.throws(() => buildModel({ services: { a: { runtimeServiceAccount: "a-run@graffiticode.iam.gserviceaccount.com", network: { ...net, proxy: "http://10.8.0.3:3128" } } } }, classes), /network.proxy/);
  assert.throws(() => buildModel({ services: { a: { runtimeServiceAccount: "a-run@graffiticode.iam.gserviceaccount.com", network: { ...net, subnet: "compilers-l0185", allow: ["eu.learnosity.com"] } } } }, classes), /open class refuses/);
});

test("the open class can never list a name it refuses, run.app included (D2)", async () => {
  const classes = await json("classes.json");
  const net = { network: "compilers", subnet: "compilers-l0185", tags: ["c"], proxy: "http://10.8.0.2:3128", ca: {}, allow: [] };
  for (const host of ["api-sja7fatcta-uc.a.run.app", "run.app", "storage.googleapis.com", "metadata.google.internal", "learnosity.net"]) {
    assert.throws(() => buildModel({ services: { a: { runtimeServiceAccount: "a-run@graffiticode.iam.gserviceaccount.com", network: { ...net, allow: [host] } } } }, classes), /open class refuses/, host);
  }
  // A strict class may still list a run.app host: it has no open route to override.
  const strict = buildModel({ services: { a: { runtimeServiceAccount: "a-run@graffiticode.iam.gserviceaccount.com", network: { ...net, subnet: "compilers-default", allow: ["policy-sja7fatcta-uc.a.run.app"] } } } }, classes);
  assert.deepEqual(strict.classes["compilers-default"].hosts, ["policy-sja7fatcta-uc.a.run.app"]);
  const open = buildModel({ services: { a: { runtimeServiceAccount: "a-run@graffiticode.iam.gserviceaccount.com", network: { ...net, allow: ["api.graffiticode.org"] } } } }, classes);
  assert.deepEqual(open.classes["compilers-l0185"].hosts, ["api.graffiticode.org"]);
});

test("the repository's own deploy.json and classes.json load", async () => {
  const model = await load();
  assert.ok(model.classes["compilers-default"]);
});

const outerHcm = (envoy, className) => envoy.static_resources.listeners.find(l => l.name === "egress")
  .filter_chains.find(c => c.name === className).filters[0].typed_config;

test("the open class forwards an ordinary public host, and refuses what D2 refuses (A10)", async () => {
  const envoy = envoyConfig(await fixture());
  const open = outerHcm(envoy, "compilers-l0185");
  const connect = authority => outcome(routeRequest(open, { method: "CONNECT", authority }));
  assert.deepEqual(connect("example.com:443"), { cluster: "open-forward" });
  assert.deepEqual(connect("www.wikipedia.org:443"), { cluster: "open-forward" });
  assert.deepEqual(connect("example.com:8443"), { refused: "port" });
  assert.deepEqual(connect("example.com:80"), { refused: "port" });
  assert.deepEqual(connect("93.184.216.34:443"), { refused: "ip-literal" });
  assert.deepEqual(connect("[2001:db8::1]:443"), { refused: "ip-literal" });
  for (const name of ["learnosity.com:443", "eu.learnosity.com:443", "items.learnosity.net:443", "api-sja7fatcta-uc.a.run.app:443", "metadata.google.internal:443", "storage.googleapis.com:443"]) {
    assert.deepEqual(connect(name), { refused: "name" }, name);
  }
  assert.deepEqual(connect("api.graffiticode.org:443"), { cluster: "terminate-compilers-l0185-api-graffiticode-org" });
  // Plain http in absolute form: the Host is the authority, without a port.
  assert.deepEqual(outcome(routeRequest(open, { method: "GET", authority: "example.com", path: "/x" })), { cluster: "open-forward" });
  assert.deepEqual(outcome(routeRequest(open, { method: "GET", authority: "eu.learnosity.com", path: "/" })), { refused: "name" });
});

test("strict classes tunnel only their listed hosts", async () => {
  const envoy = envoyConfig(await fixture());
  const strict = outerHcm(envoy, "compilers-default");
  const connect = authority => outcome(routeRequest(strict, { method: "CONNECT", authority }));
  assert.ok(connect("policy-sja7fatcta-uc.a.run.app:443").cluster?.startsWith("terminate-compilers-default"));
  for (const a of ["example.com:443", "storage.googleapis.com:443", "api.graffiticode.org:443", "policy-sja7fatcta-uc.a.run.app:8443"]) {
    assert.deepEqual(connect(a), { refused: "unlisted" }, a);
  }
});

test("every safe_regex is written for Envoy's full-match semantics", async () => {
  const regexes = [];
  const walk = n => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    if (n.safe_regex) regexes.push(n.safe_regex.regex);
    Object.values(n).forEach(walk);
  };
  walk(envoyConfig(await fixture()));
  assert.ok(regexes.length > 0);
  for (const r of regexes) assert.ok(r.startsWith("^") && r.endsWith("$"), `${r} must be anchored: Envoy matches the whole value`);
  assert.deepEqual([...new Set(regexes)].sort(), [IP_LITERAL, TRAILING_DOT].sort());
});

test("a trailing dot never steps around a refusal (A1)", async () => {
  const envoy = envoyConfig(await fixture());
  for (const chain of envoy.static_resources.listeners.flatMap(l => l.filter_chains)) {
    for (const f of chain.filters.filter(x => x.name === "envoy.filters.network.http_connection_manager")) {
      assert.equal(f.typed_config.strip_trailing_host_dot, true, `${chain.name ?? "chain"} strips the trailing dot`);
    }
  }
  const open = outerHcm(envoy, "compilers-l0185");
  const strict = outerHcm(envoy, "compilers-default");
  // With Envoy stripping the dot as documented, and, in case it doesn't for a
  // CONNECT authority, without: either way the name is refused.
  for (const strip of [true, false]) {
    const o = { ...open, strip_trailing_host_dot: strip };
    const connect = authority => outcome(routeRequest(o, { method: "CONNECT", authority }));
    for (const a of ["learnosity.com.:443", "eu.learnosity.com.:443", "api-sja7fatcta-uc.a.run.app.:443", "metadata.google.internal.:443"]) {
      const got = connect(a);
      assert.ok(got.refused === "name" || got.refused === "trailing-dot", `${a} (strip ${strip}): ${JSON.stringify(got)}`);
    }
    assert.deepEqual(connect("learnosity.com..:443"), { refused: "trailing-dot" });
    assert.ok(outcome(routeRequest(o, { method: "GET", authority: "eu.learnosity.com.", path: "/" })).refused);
    const s = { ...strict, strip_trailing_host_dot: strip };
    assert.ok(outcome(routeRequest(s, { method: "CONNECT", authority: "example.com.:443" })).refused);
  }
  // Stripped, an ordinary name still forwards, and a refused one is refused by name.
  assert.deepEqual(outcome(routeRequest(open, { method: "CONNECT", authority: "example.com.:443" })), { cluster: "open-forward" });
  assert.deepEqual(outcome(routeRequest(open, { method: "CONNECT", authority: "learnosity.com.:443" })), { refused: "name" });
  assert.ok(fullMatch(TRAILING_DOT, "a.b.:443") && fullMatch(TRAILING_DOT, "a.b.") && !fullMatch(TRAILING_DOT, "a.b:443") && !fullMatch(TRAILING_DOT, "[::1]:443"));
});

test("every access log carries the contract's fields, and every route says its decision (A5)", async () => {
  const envoy = envoyConfig(await fixture());
  const { listeners } = envoy.static_resources;
  const fieldsOf = logs => logs[0].typed_config.log_format.json_format;
  const hcms = listeners.filter(l => l.name !== "health").flatMap(l => l.filter_chains.flatMap(fc => fc.filters))
    .filter(f => f.name === "envoy.filters.network.http_connection_manager").map(f => f.typed_config);
  assert.ok(hcms.length >= 5);
  for (const h of hcms) {
    const fields = fieldsOf(h.access_log);
    for (const k of LOG_FIELDS) assert.ok(k in fields, `${h.stat_prefix} logs ${k}`);
    assert.equal(fields.probe, "%REQ(X-ISOLATE01-PROBE)%");
    assert.equal(fields.decision, "%RESP(X-ISOLATE01-DECISION)%");
    assert.equal(fields.reason, "%RESP(X-ISOLATE01-REASON)%");
    for (const route of h.route_config.virtual_hosts.flatMap(v => v.routes)) {
      const added = Object.fromEntries((route.response_headers_to_add ?? []).map(x => [x.header.key, x.header.value]));
      assert.ok(["allow", "refuse"].includes(added["x-isolate01-decision"]), `${h.stat_prefix}: every route sets a decision`);
      assert.ok(added["x-isolate01-reason"], `${h.stat_prefix}: every route sets a reason`);
      if (route.direct_response) {
        assert.equal(added["x-isolate01-decision"], "refuse");
        assert.equal(added["x-isolate01-refused"], added["x-isolate01-reason"]);
      } else {
        assert.equal(added["x-isolate01-decision"], "allow");
        assert.ok(["listed", "open"].includes(added["x-isolate01-reason"]));
        assert.deepEqual(route.response_headers_to_remove, ["x-isolate01-refused"], "an upstream can't forge a refusal");
      }
      for (const x of route.response_headers_to_add ?? []) assert.equal(x.append_action, "OVERWRITE_IF_EXISTS_OR_ADD");
    }
  }
  // Inner lines name the chain's host as the target.
  for (const l of listeners.filter(x => x.internal_listener)) {
    for (const fc of l.filter_chains) {
      const [host] = fc.filter_chain_match.server_names;
      assert.equal(fieldsOf(fc.filters[1].typed_config.access_log).target, host);
    }
  }
});

test("refusals before HTTP are logged at the connection level (A5)", async () => {
  const envoy = envoyConfig(await fixture());
  const { listeners } = envoy.static_resources;
  const inner = listeners.filter(l => l.internal_listener);
  assert.ok(inner.length > 0);
  for (const l of [...inner, listeners.find(x => x.name === "egress")]) {
    const fields = l.access_log[0].typed_config.log_format.json_format;
    for (const k of TCP_LOG_FIELDS) assert.ok(k in fields, `${l.name} logs ${k}`);
    assert.equal(fields.termination, "%CONNECTION_TERMINATION_DETAILS%");
    assert.equal(fields.target, "%DYNAMIC_METADATA(isolate01:target)%");
    assert.equal(fields.isolate01, l.internal_listener ? "terminate-tcp" : "egress-tcp");
  }
});

const cloudConfig = model => JSON.parse(cloudInit(model, envoyConfig(model)).slice("#cloud-config\n".length));

test("the proxy VMs' own DNS is the fixed resolvers, set before anything looks up a name (A11)", async () => {
  const model = await fixture();
  const config = cloudConfig(model);
  const file = p => config.write_files.find(f => f.path === p)?.content;
  const resolver = file("/etc/egress-proxy/resolver.sh");
  assert.match(resolver, /rm -f \/etc\/resolv\.conf/);
  assert.match(resolver, /printf '%s\\n' 'nameserver 8\.8\.8\.8' 'nameserver 8\.8\.4\.4' 'options timeout:2 attempts:2' > \/etc\/resolv\.conf/);
  assert.match(resolver, /'DNS=8\.8\.8\.8 8\.8\.4\.4' 'FallbackDNS=' 'Domains=~\.'/, "no fallback to the metadata resolver");
  assert.match(resolver, /169\.254\.169\.254 metadata\.google\.internal/, "metadata pinned in /etc/hosts");
  assert.doesNotMatch(resolver, /nameserver 169\.254/);
  const check = file("/etc/egress-proxy/resolver-check.sh");
  assert.match(check, /= '8\.8\.8\.8 8\.8\.4\.4' \] \|\| fail/);
  // First in runcmd, and required (with its check) by everything that fetches.
  assert.deepEqual(config.runcmd[1], ["systemctl", "start", "egress-resolver.service"]);
  assert.equal(config.runcmd[0][1], "daemon-reload");
  for (const u of ["egress-certs.service", "egress-envoy.service"]) {
    const text = file(`/etc/systemd/system/${u}`);
    assert.match(text, /Requires=.*egress-resolver\.service/, u);
    assert.match(text, /After=.*egress-resolver\.service/, u);
    assert.match(text, /ExecStartPre=\/bin\/bash \/etc\/egress-proxy\/resolver-check\.sh/, u);
  }
  // Envoy's own resolution is separate: the same fixed resolvers, through c-ares.
  const envoy = envoyConfig(model);
  const dfp = envoy.static_resources.clusters.find(c => c.name === "open-forward").cluster_type.typed_config.dns_cache_config;
  assert.deepEqual(dfp.typed_dns_resolver_config.typed_config.resolvers.map(r => r.socket_address.address), model.proxy.resolvers);
});

test("every REJECT in ENVOY_OUT is logged just before it, under its rule's name (A14)", async () => {
  const model = await fixture();
  const rules = envoyOutRules(model);
  const named = rejectRules(model);
  const rejects = rules.map((r, i) => [r, i]).filter(([r]) => r.endsWith("-j REJECT"));
  assert.equal(rejects.length, named.length);
  for (const [r, i] of rejects) {
    const cidr = r.match(/-d (\S+)/)[1];
    const log = rules[i - 1];
    const { name } = named.find(n => n.cidr === cidr);
    assert.equal(log, `-m conntrack --ctstate NEW -d ${cidr} -m limit --limit 20/second --limit-burst 100 -j LOG --log-prefix "${REJECT_PREFIX}${name} " --log-level 4`);
    assert.ok(`${REJECT_PREFIX}${name} `.length <= 29, "iptables limits a LOG prefix to 29 characters");
  }
  // The specific ranges come before 10/8, so their own name is what logs.
  const order = named.map(n => n.name);
  for (const n of ["lb", "c-default", "c-l0013", "c-l0185", "proxy-net"]) assert.ok(order.indexOf(n) < order.indexOf("private"), n);
  assert.deepEqual(named.find(n => n.cidr === "169.254.0.0/16").name, "metadata");
  assert.deepEqual(named.find(n => n.cidr === "199.36.153.8/30").name, "goog-priv");
  assert.deepEqual(named.find(n => n.cidr === "199.36.153.4/30").name, "goog-restr");
  assert.throws(() => rejectRules({ ...model, classes: { "compilers-averyverylongname": { name: "compilers-averyverylongname", cidr: "10.9.0.0/24" } } }), /1-11 characters/);
});

// What `iptables -S ENVOY_OUT` would print for the generated rules (it moves
// -d first; the awk programs read it from anywhere).
const listed = rules => rules.map(r => {
  const d = r.match(/ -d (\S+)/);
  return `-A ENVOY_OUT ${d ? `-d ${d[1]} ${r.replace(d[0], "")}` : r}`.replace(/ +/g, " ");
});
const awk = (program, lines) => spawnSync("awk", [program], { input: lines.join("\n") + "\n", encoding: "utf8" });

test("the firewall self-check's awk accepts the generated chain and refuses a REJECT without its LOG (A14)", async () => {
  const model = await fixture();
  const lines = listed(envoyOutRules(model));
  assert.equal(awk(ORDER_AWK, lines).stdout, "ERAD");
  assert.equal(awk(PAIRS_AWK, lines).status, 0);
  const firstLog = lines.findIndex(l => l.includes(" -j LOG "));
  const unlogged = lines.filter((_, i) => i !== firstLog);
  assert.notEqual(awk(PAIRS_AWK, unlogged).status, 0, "a REJECT with no LOG before it");
  const swapped = [...lines];
  [swapped[firstLog], swapped[firstLog + 1]] = [swapped[firstLog + 1], swapped[firstLog]];
  assert.notEqual(awk(PAIRS_AWK, swapped).status, 0, "a LOG after its REJECT");
  const mismatched = lines.map((l, i) => (i === firstLog ? l.replace(/-d \S+/, "-d 192.0.2.0/24") : l));
  assert.notEqual(awk(PAIRS_AWK, mismatched).status, 0, "a LOG for another destination");
  const config = JSON.parse(cloudInit(model, envoyConfig(model)).slice("#cloud-config\n".length));
  const check = config.write_files.find(f => f.path === "/etc/egress-proxy/firewall-check.sh").content;
  assert.ok(check.includes("a REJECT in ENVOY_OUT is not logged just before it"));
});

test("no access log writes a request's query: a query can carry a token (2026-10-20)", async () => {
  const envoy = envoyConfig(await fixture());
  const formats = [];
  JSON.stringify(envoy, (k, v) => { if (k === "json_format") formats.push(v); return v; });
  assert.ok(formats.length > 0);
  for (const f of formats) {
    for (const [field, op] of Object.entries(f)) {
      assert.ok(!/%REQ\(:PATH\)%|%PATH(\(WQ[^)]*\))?%|%REQ\(X-ENVOY-ORIGINAL-PATH/.test(op), `${field}: ${op} can log a query`);
    }
  }
  assert.ok(formats.some(f => f.path === "%PATH(NQ:ORIG)%"), "the inner line logs the path without its query");
});
