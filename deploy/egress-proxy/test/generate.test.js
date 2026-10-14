/* eslint camelcase: "off" -- Envoy's configuration API is snake_case. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BLOCKED, EXTENSIONS, buildModel, cloudInit, envoyConfig, envoyOutRules, extensionsUsed, load, terminatedHosts,
} from "../generate.js";

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
  await golden("cloud-init.golden.yaml", cloudInit(model, envoy));
});

test("classes get exactly their own services' hosts", async () => {
  const model = await fixture();
  assert.deepEqual(model.classes["compilers-default"].hosts, ["broker-sja7fatcta-uc.a.run.app", "policy-sja7fatcta-uc.a.run.app"]);
  assert.deepEqual(model.classes["compilers-l0013"].hosts, ["storage.googleapis.com"]);
  assert.deepEqual(model.classes["compilers-l0185"].hosts, ["api-sja7fatcta-uc.a.run.app"]);
  assert.equal(model.classes["compilers-l0185"].open, true);
  assert.deepEqual(terminatedHosts(model), ["api-sja7fatcta-uc.a.run.app", "broker-sja7fatcta-uc.a.run.app", "policy-sja7fatcta-uc.a.run.app", "storage.googleapis.com"]);
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
    assert.ok(tunnels.every(r => r.route.cluster === `terminate-${cls.name}`), `${cls.name} tunnels only to its own listener`);
    assert.deepEqual(tunnels.map(r => r.metadata.filter_metadata.isolate01.target).sort(), cls.hosts);
  }
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
    assert.deepEqual(principal.metadata.value, { string_match: { exact: host } });
    const vhosts = http.typed_config.route_config.virtual_hosts;
    assert.deepEqual(vhosts[0].domains, [host, `${host}:443`]);
    assert.equal(vhosts[1].routes[0].direct_response.status, 403, "any other Host is refused");
  }
  const clusters = envoy.static_resources.clusters.filter(c => c.name.startsWith("terminate-"));
  for (const c of clusters) {
    assert.deepEqual(c.transport_socket.typed_config.passthrough_metadata, [{ kind: { route: {} }, name: "isolate01" }]);
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
  assert.equal(catchAll.routes[0].direct_response.status, 403);
  assert.equal(catchAll.routes[1].direct_response.status, 403);
  const regex = new RegExp(catchAll.routes[0].match.headers[0].string_match.safe_regex.regex);
  for (const literal of ["93.184.216.34:443", "10.0.0.1", "[2001:db8::1]:443", "[::ffff:169.254.169.254]:80"]) assert.ok(regex.test(literal), literal);
  assert.ok(!regex.test("example.com:443"));
  assert.equal(catchAll.routes[2].route.cluster, "open-forward");
  assert.equal(catchAll.routes[3].direct_response.status, 403, "CONNECT to another port");
  // The listed Graffiticode host is still terminated, not forwarded, for L0185.
  assert.equal(open[0].routes[0].route.cluster, "terminate-compilers-l0185");
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
  const kinds = rules.map(r => r === rules[0] ? "established" : / -j REJECT$/.test(r) ? "reject" : / -j ACCEPT$/.test(r) ? "accept" : "drop");
  const order = kinds.filter((k, i) => k !== kinds[i - 1]);
  assert.deepEqual(order, ["established", "reject", "accept", "drop"]);
  const rejected = rules.filter(r => r.endsWith("-j REJECT")).map(r => r.match(/-d (\S+)/)[1]);
  for (const c of [...BLOCKED, "169.254.0.0/16", "10.8.16.0/22", "10.8.24.0/24", "10.8.20.0/22", "10.8.0.0/27", "10.8.0.2/32"]) assert.ok(rejected.includes(c), c);
  assert.ok(rules.filter(r => r.includes("NEW")).every(r => r.includes("--ctstate NEW")), "every filter after the first is on NEW connections");
  assert.ok(rules.includes("-m conntrack --ctstate NEW -p udp -d 8.8.8.8/32 --dport 53 -j ACCEPT"));
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
  assert.throws(() => buildModel({ services: { a: { network: { ...net, subnet: "nope" } } } }, classes), /not a class/);
  assert.throws(() => buildModel({ services: { a: { network: { ...net, network: "default" } } } }, classes), /must be compilers/);
  assert.throws(() => buildModel({ services: { a: { network: { ...net, proxy: "http://10.8.0.3:3128" } } } }, classes), /network.proxy/);
  assert.throws(() => buildModel({ services: { a: { network: { ...net, subnet: "compilers-l0185", allow: ["eu.learnosity.com"] } } } }, classes), /open class refuses/);
});

test("the repository's own deploy.json and classes.json load", async () => {
  const model = await load();
  assert.ok(model.classes["compilers-default"]);
});
