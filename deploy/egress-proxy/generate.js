#!/usr/bin/env node
/* eslint camelcase: "off" -- Envoy's configuration API is snake_case. */
// ISOLATE-01: the egress proxy's configuration, generated from deploy.json
// (each compiler's network.subnet and network.allow) and classes.json (the
// subnets, the L0185 open class, the proxy's fixed settings). Plan:
// ~/.claude/plans/isolate-01-compiler-egress.md, "The proxy". Runbook: README.md.
//
//   node deploy/egress-proxy/generate.js [--deploy deploy.json] [--classes classes.json] [--out dir]
//
// Writes envoy.json and cloud-init.yaml to --out (default deploy/egress-proxy/out).
// Nothing here contacts the cloud; infra.js prints the commands that use these.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "../..");

// Never a new connection from Envoy, whatever a name resolved to: private,
// loopback, link-local (the metadata server), CGNAT, multicast, reserved, and
// Google's private-access VIPs. The compiler subnets and the load balancer are
// added per model.
export const BLOCKED = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
  "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/4", "240.0.0.0/4",
  "199.36.153.4/30", "199.36.153.8/30",
];

// Every extension the generated config may name. All are stable in Envoy;
// the SNI dynamic forward proxy (alpha) is deliberately absent.
export const EXTENSIONS = new Set([
  "envoy.bootstrap.internal_listener",
  "envoy.filters.network.http_connection_manager",
  "envoy.filters.network.rbac",
  "envoy.filters.listener.tls_inspector",
  "envoy.filters.http.dynamic_forward_proxy",
  "envoy.filters.http.router",
  "envoy.clusters.dynamic_forward_proxy",
  "envoy.transport_sockets.tls",
  "envoy.transport_sockets.internal_upstream",
  "envoy.transport_sockets.raw_buffer",
  "envoy.network.dns_resolver.cares",
  "envoy.access_loggers.stdout",
  "envoy.upstreams.http.http_protocol_options",
]);

const CERT_DIR = "/run/egress-proxy/certs";
const CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const META = "isolate01";

export const slug = host => host.replace(/\./g, "-");
const cidr = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const ip = /^(\d{1,3}\.){3}\d{1,3}$/;

// The model: classes with the hosts their compilers may reach.
export function buildModel(deployConfig, classes) {
  const model = {
    project: classes.project,
    region: classes.region,
    network: classes.network,
    proxySubnet: classes.proxySubnet,
    loadBalancerAddress: classes.loadBalancerAddress,
    proxy: classes.proxy,
    denySuffixes: classes.open?.denySuffixes ?? [],
    classes: {},
  };
  if (!ip.test(model.loadBalancerAddress)) throw new Error("classes.json: loadBalancerAddress must be an IPv4 address");
  if (!cidr.test(model.proxySubnet?.cidr ?? "")) throw new Error("classes.json: proxySubnet.cidr must be an IPv4 CIDR");
  for (const [name, c] of Object.entries(classes.classes ?? {})) {
    if (!/^compilers-[a-z0-9-]+$/.test(name)) throw new Error(`classes.json: class ${name} must be named compilers-<name>`);
    if (!cidr.test(c.cidr ?? "")) throw new Error(`classes.json: class ${name} needs an IPv4 cidr`);
    model.classes[name] = { name, cidr: c.cidr, open: c.open === true, hosts: new Set(), services: [], accounts: [] };
  }
  for (const [service, config] of Object.entries(deployConfig.services ?? {})) {
    const n = config.network;
    if (!n) continue;
    const cls = model.classes[n.subnet];
    if (!cls) throw new Error(`deploy.json: ${service}'s network.subnet ${n.subnet} is not a class in classes.json`);
    if (n.network !== model.network) throw new Error(`deploy.json: ${service}'s network.network must be ${model.network}`);
    if (n.proxy !== `http://${model.loadBalancerAddress}:${model.proxy.listenPort}`) {
      throw new Error(`deploy.json: ${service}'s network.proxy must be http://${model.loadBalancerAddress}:${model.proxy.listenPort}`);
    }
    cls.services.push(service);
    // The runtime identity reads the CA bundle (infra.js binds it).
    if (!/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(config.runtimeServiceAccount ?? "")) {
      throw new Error(`deploy.json: ${service} has a network block but no runtimeServiceAccount`);
    }
    cls.accounts.push(config.runtimeServiceAccount);
    for (const host of n.allow) {
      // An exact listed route would win over the open class's wildcard
      // refusals, so a refused name can never be listed for it (D2: no
      // run.app at all; L0185 reaches Graffiticode by *.graffiticode.org).
      if (cls.open && denied(host, model.denySuffixes)) {
        throw new Error(`deploy.json: ${service} lists ${host}, which the open class refuses (${model.denySuffixes.find(s => host === s || host.endsWith(`.${s}`))})`);
      }
      cls.hosts.add(host);
    }
  }
  for (const cls of Object.values(model.classes)) {
    cls.hosts = [...cls.hosts].sort();
    cls.accounts = [...new Set(cls.accounts)].sort();
  }
  return model;
}

const denied = (host, suffixes) => suffixes.some(s => host === s || host.endsWith(`.${s}`));

// Every compiler runtime account behind the proxy: each reads the CA bundle.
export const compilerAccounts = model =>
  [...new Set(Object.values(model.classes).flatMap(c => c.accounts))].sort();

// Every host terminated anywhere, each with its own certificate.
export const terminatedHosts = model =>
  [...new Set(Object.values(model.classes).flatMap(c => c.hosts))].sort();

const caresResolver = model => ({
  name: "envoy.network.dns_resolver.cares",
  typed_config: {
    "@type": "type.googleapis.com/envoy.extensions.network.dns_resolver.cares.v3.CaresDnsResolverConfig",
    resolvers: model.proxy.resolvers.map(address => ({ socket_address: { address, port_value: 53 } })),
    use_resolvers_as_fallback: false,
    dns_resolver_options: { no_default_search_domain: true },
  },
});

const accessLog = (fields) => [{
  name: "envoy.access_loggers.stdout",
  typed_config: {
    "@type": "type.googleapis.com/envoy.extensions.access_loggers.stream.v3.StdoutAccessLog",
    log_format: { json_format: fields },
  },
}];

// The access-log contract (AT-11's collector reads these exact fields).
// Every HTTP line, outer and inner: what was asked, what Envoy decided and
// why, where it went, and the probe id AT-11 sends in x-isolate01-probe.
// `decision` and `reason` come from response headers every route sets
// (allowed routes too), since a log line can't compute them.
export const LOG_FIELDS = ["isolate01", "class", "downstream", "method", "target", "sni", "host", "upstream", "upstream_host", "code", "flags", "details", "decision", "reason", "probe", "start"];
const decisionFields = {
  decision: "%RESP(X-ISOLATE01-DECISION)%",
  reason: "%RESP(X-ISOLATE01-REASON)%",
  probe: "%REQ(X-ISOLATE01-PROBE)%",
};

const outerLogFields = className => ({
  isolate01: "egress",
  class: className,
  downstream: "%DOWNSTREAM_DIRECT_REMOTE_ADDRESS%",
  method: "%REQ(:METHOD)%",
  target: "%REQ(:AUTHORITY)%",
  sni: "%REQUESTED_SERVER_NAME%",
  host: "%REQ(:AUTHORITY)%",
  upstream: "%UPSTREAM_REMOTE_ADDRESS%",
  upstream_host: "%UPSTREAM_HOST%",
  upstream_cluster: "%UPSTREAM_CLUSTER%",
  code: "%RESPONSE_CODE%",
  flags: "%RESPONSE_FLAGS%",
  details: "%RESPONSE_CODE_DETAILS%",
  ...decisionFields,
  refused: "%RESP(X-ISOLATE01-REFUSED)%",
  bytes_in: "%BYTES_RECEIVED%",
  bytes_out: "%BYTES_SENT%",
  start: "%START_TIME%",
});

// Inner: one HCM per (class, host) chain, so `target` is that chain's host,
// which RBAC has already required the CONNECT target to equal.
// `target_metadata` is the passed-through value itself, where Envoy exposes
// the connection's dynamic metadata to an HTTP log (step 0 checks it; "-" if not).
const innerLogFields = (className, host) => ({
  isolate01: "terminate",
  class: className,
  downstream: "%DOWNSTREAM_DIRECT_REMOTE_ADDRESS%",
  method: "%REQ(:METHOD)%",
  target: host,
  target_metadata: "%DYNAMIC_METADATA(isolate01:target)%",
  sni: "%REQUESTED_SERVER_NAME%",
  host: "%REQ(:AUTHORITY)%",
  path: "%REQ(:PATH)%",
  upstream: "%UPSTREAM_REMOTE_ADDRESS%",
  upstream_host: "%UPSTREAM_HOST%",
  code: "%RESPONSE_CODE%",
  flags: "%RESPONSE_FLAGS%",
  details: "%RESPONSE_CODE_DETAILS%",
  ...decisionFields,
  refused: "%RESP(X-ISOLATE01-REFUSED)%",
  start: "%START_TIME%",
});

// Connection-level lines, for what closes before HTTP runs: an inner
// listener's unknown SNI (flags NR) and RBAC refusal (termination details
// name rbac), and an outer connection from outside every class subnet (NR).
// No decision field: refusals.js's tcpDecision derives it.
export const TCP_LOG_FIELDS = ["isolate01", "class", "sni", "target", "termination", "flags", "filter_chain", "probe", "start"];
const tcpLogFields = (kind, className) => ({
  isolate01: kind,
  class: className,
  downstream: "%DOWNSTREAM_DIRECT_REMOTE_ADDRESS%",
  sni: "%REQUESTED_SERVER_NAME%",
  target: "%DYNAMIC_METADATA(isolate01:target)%",
  termination: "%CONNECTION_TERMINATION_DETAILS%",
  flags: "%RESPONSE_FLAGS%",
  filter_chain: "%FILTER_CHAIN_NAME%",
  duration: "%DURATION%",
  bytes_in: "%BYTES_RECEIVED%",
  bytes_out: "%BYTES_SENT%",
  probe: "-",
  start: "%START_TIME%",
});

const OVERWRITE = "OVERWRITE_IF_EXISTS_OR_ADD";
const decisionHeaders = (decision, reason) => [
  { header: { key: "x-isolate01-decision", value: decision }, append_action: OVERWRITE },
  { header: { key: "x-isolate01-reason", value: reason }, append_action: OVERWRITE },
];

const refuse = (reason) => ({
  direct_response: { status: 403, body: { inline_string: `isolate01: refused (${reason})\n` } },
  response_headers_to_add: [
    { header: { key: "x-isolate01-refused", value: reason }, append_action: OVERWRITE },
    ...decisionHeaders("refuse", reason),
  ],
});

// An allowed route: its decision headers, and never an upstream's own
// x-isolate01-* headers, so an upstream can't forge a refusal or a decision.
const allow = (reason, route) => ({
  route,
  response_headers_to_add: decisionHeaders("allow", reason),
  response_headers_to_remove: ["x-isolate01-refused"],
});

// IPv4 and bracketed IPv6 literals, with or without a port. Envoy's
// safe_regex is a full match (RE2), so this matches the whole authority; every
// regex here is written anchored on both ends to say so.
export const IP_LITERAL = String.raw`^(\[[0-9A-Fa-f:.]+\]|[0-9]{1,3}(\.[0-9]{1,3}){3})(:[0-9]+)?$`;

// An authority still ending in a dot after strip_trailing_host_dot (two dots,
// or a form Envoy doesn't strip): refused outright, never routed.
export const TRAILING_DOT = String.raw`^[^\[]*\.(:[0-9]+)?$`;
const trailingDotRoutes = () => {
  const headers = [{ name: ":authority", string_match: { safe_regex: { regex: TRAILING_DOT } } }];
  return [{ match: { connect_matcher: {}, headers }, ...refuse("trailing-dot") }, { match: { prefix: "", headers }, ...refuse("trailing-dot") }];
};

const hcm = (statPrefix, routeConfig, httpFilters, logFields) => ({
  name: "envoy.filters.network.http_connection_manager",
  typed_config: {
    "@type": "type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager",
    stat_prefix: statPrefix,
    codec_type: "AUTO",
    // The class comes from the connection's own address; nothing a client
    // sends is trusted to say who it is.
    use_remote_address: true,
    xff_num_trusted_hops: 0,
    skip_xff_append: true,
    // "learnosity.com." is learnosity.com: strip the dot before any routing,
    // so a trailing dot can't step around an exact or wildcard domain.
    strip_trailing_host_dot: true,
    normalize_path: true,
    merge_slashes: true,
    path_with_escaped_slashes_action: "REJECT_REQUEST",
    http_protocol_options: { allow_absolute_url: true },
    http2_protocol_options: { allow_connect: true },
    upgrade_configs: [{ upgrade_type: "CONNECT" }],
    route_config: routeConfig,
    http_filters: [...httpFilters, {
      name: "envoy.filters.http.router",
      typed_config: { "@type": "type.googleapis.com/envoy.extensions.filters.http.router.v3.Router" },
    }],
    access_log: accessLog(logFields),
  },
});

// A CONNECT to a listed host: terminate the CONNECT and hand its bytes to
// this class's internal listener through the host's own internal cluster,
// whose one endpoint carries the target as host metadata (A2).
export const internalClusterName = (className, host) => `terminate-${className}-${slug(host)}`;
const tunnelRoute = (host, className) => ({
  match: { connect_matcher: {} },
  ...allow("listed", { cluster: internalClusterName(className, host), upgrade_configs: [{ upgrade_type: "CONNECT", connect_config: {} }] }),
});

function outerRouteConfig(cls, model) {
  const virtual_hosts = cls.hosts.map(host => ({
    name: `listed-${slug(host)}`,
    domains: [`${host}:443`],
    routes: [tunnelRoute(host, cls.name)],
  }));
  if (cls.open) {
    const deny = model.denySuffixes.flatMap(s => [s, `*.${s}`]).flatMap(d => [d, `${d}:443`, `${d}:80`]);
    virtual_hosts.push({ name: "open-refused-names", domains: deny, routes: [{ match: { prefix: "" }, ...refuse("name") }, { match: { connect_matcher: {} }, ...refuse("name") }] });
    const ipLiteral = [{ name: ":authority", string_match: { safe_regex: { regex: IP_LITERAL } } }];
    // A suffix, not a regex: Envoy's safe_regex must match the whole value,
    // so ":443$" would never match "example.com:443".
    const port443 = [{ name: ":authority", string_match: { suffix: ":443" } }];
    virtual_hosts.push({
      name: "open",
      domains: ["*"],
      routes: [
        ...trailingDotRoutes(),
        { match: { connect_matcher: {}, headers: ipLiteral }, ...refuse("ip-literal") },
        { match: { prefix: "/", headers: ipLiteral }, ...refuse("ip-literal") },
        { match: { connect_matcher: {}, headers: port443 }, ...allow("open", { cluster: "open-forward", upgrade_configs: [{ upgrade_type: "CONNECT", connect_config: {} }] }) },
        { match: { connect_matcher: {} }, ...refuse("port") },
        // Plain http, absolute form: forwarded the same way, same checks.
        { match: { prefix: "/" }, ...allow("open", { cluster: "open-forward", timeout: "30s" }) },
      ],
    });
  } else {
    virtual_hosts.push({ name: "unlisted", domains: ["*"], routes: [...trailingDotRoutes(), { match: { connect_matcher: {} }, ...refuse("unlisted") }, { match: { prefix: "" }, ...refuse("unlisted") }] });
  }
  return { name: `egress-${cls.name}`, virtual_hosts };
}

const dnsCache = model => ({
  name: "open_forward_cache",
  dns_lookup_family: "V4_ONLY",
  typed_dns_resolver_config: caresResolver(model),
  max_hosts: 4096,
});

function outerListener(model) {
  const filter_chains = Object.values(model.classes).map(cls => ({
    name: cls.name,
    // Direct source: the peer of this TCP connection. The passthrough load
    // balancer keeps the compiler's address; PROXY protocol isn't accepted.
    filter_chain_match: { direct_source_prefix_ranges: [prefix(cls.cidr)] },
    filters: [hcm(`egress_${cls.name.replace(/-/g, "_")}`, outerRouteConfig(cls, model),
      cls.open
        ? [{
            name: "envoy.filters.http.dynamic_forward_proxy",
            typed_config: {
              "@type": "type.googleapis.com/envoy.extensions.filters.http.dynamic_forward_proxy.v3.FilterConfig",
              dns_cache_config: dnsCache(model),
            },
          }]
        : [],
      outerLogFields(cls.name))],
  }));
  // No default filter chain: a connection from outside every class subnet is closed.
  return {
    name: "egress",
    access_log: accessLog(tcpLogFields("egress-tcp", "-")),
    address: { socket_address: { address: "0.0.0.0", port_value: model.proxy.listenPort } },
    filter_chains,
  };
}

const prefix = c => {
  const [address, len] = c.split("/");
  return { address_prefix: address, prefix_len: Number(len) };
};

// The listener that terminates one class's TLS. Each listed host has its own
// filter chain (by SNI), its own certificate, and an RBAC filter requiring the
// CONNECT target carried from the outer listener to be that same host; its
// HTTP routes then accept only that host as Host / :authority.
function innerListener(cls) {
  const filter_chains = cls.hosts.map(host => ({
    name: `${cls.name}-${slug(host)}`,
    filter_chain_match: { server_names: [host] },
    transport_socket: {
      name: "envoy.transport_sockets.tls",
      typed_config: {
        "@type": "type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext",
        common_tls_context: {
          tls_params: { tls_minimum_protocol_version: "TLSv1_2" },
          alpn_protocols: ["h2", "http/1.1"],
          tls_certificates: [{
            certificate_chain: { filename: `${CERT_DIR}/${slug(host)}.crt` },
            private_key: { filename: `${CERT_DIR}/${slug(host)}.key` },
          }],
        },
      },
    },
    filters: [
      {
        name: "envoy.filters.network.rbac",
        typed_config: {
          "@type": "type.googleapis.com/envoy.extensions.filters.network.rbac.v3.RBAC",
          stat_prefix: `target_${slug(host).replace(/-/g, "_")}`,
          rules: {
            action: "ALLOW",
            policies: {
              "connect-target-is-sni": {
                permissions: [{ any: true }],
                principals: [{
                  metadata: {
                    filter: META,
                    path: [{ key: "target" }],
                    value: { string_match: { exact: host } },
                  },
                }],
              },
            },
          },
        },
      },
      hcm(`terminate_${slug(host).replace(/-/g, "_")}`, {
        name: `terminate-${cls.name}-${slug(host)}`,
        virtual_hosts: [
          { name: slug(host), domains: [host, `${host}:443`], routes: [{ match: { prefix: "/" }, ...allow("listed", { cluster: `upstream-${slug(host)}`, timeout: "300s" }) }] },
          { name: "fronted", domains: ["*"], routes: [{ match: { prefix: "" }, ...refuse("host-mismatch") }] },
        ],
      }, [], innerLogFields(cls.name, host)),
    ],
  }));
  return {
    name: `terminate-${cls.name}`,
    internal_listener: {},
    access_log: accessLog(tcpLogFields("terminate-tcp", cls.name)),
    listener_filters: [{
      name: "envoy.filters.listener.tls_inspector",
      typed_config: { "@type": "type.googleapis.com/envoy.extensions.filters.listener.tls_inspector.v3.TlsInspector" },
    }],
    // No default chain: no SNI, or an SNI not listed for this class, is closed.
    filter_chains,
  };
}

function upstreamCluster(host, model) {
  return {
    name: `upstream-${slug(host)}`,
    type: "LOGICAL_DNS",
    dns_lookup_family: "V4_ONLY",
    typed_dns_resolver_config: caresResolver(model),
    connect_timeout: "5s",
    load_assignment: {
      cluster_name: `upstream-${slug(host)}`,
      endpoints: [{ lb_endpoints: [{ endpoint: { address: { socket_address: { address: host, port_value: 443 } } } }] }],
    },
    transport_socket: {
      name: "envoy.transport_sockets.tls",
      typed_config: {
        "@type": "type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext",
        sni: host,
        common_tls_context: {
          alpn_protocols: ["h2", "http/1.1"],
          validation_context: {
            trusted_ca: { filename: CA_BUNDLE },
            match_typed_subject_alt_names: [{ san_type: "DNS", matcher: { exact: host } }],
          },
        },
      },
    },
    typed_extension_protocol_options: {
      "envoy.extensions.upstreams.http.v3.HttpProtocolOptions": {
        "@type": "type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions",
        upstream_http_protocol_options: { auto_sni: false, auto_san_validation: false },
        auto_config: { http2_protocol_options: {}, http_protocol_options: {} },
      },
    },
  };
}

// One internal cluster per (class, listed host). Its single endpoint is the
// class's internal listener and carries the CONNECT target as endpoint (host)
// metadata. internal_upstream passes host-kind metadata into the internal
// connection's dynamic metadata, where the inner RBAC filter requires it to
// equal the SNI. (Route-kind metadata, the merged design, most likely isn't
// accepted by internal_upstream, and one endpoint per class couldn't carry a
// per-host value anyway. Rollout step 0 confirms this with envoy --mode
// validate and a live tunnel.)
const internalCluster = (cls, host) => ({
  name: internalClusterName(cls.name, host),
  type: "STATIC",
  connect_timeout: "1s",
  load_assignment: {
    cluster_name: internalClusterName(cls.name, host),
    endpoints: [{
      lb_endpoints: [{
        endpoint: { address: { envoy_internal_address: { server_listener_name: `terminate-${cls.name}` } } },
        metadata: { filter_metadata: { [META]: { target: host } } },
      }],
    }],
  },
  transport_socket: {
    name: "envoy.transport_sockets.internal_upstream",
    typed_config: {
      "@type": "type.googleapis.com/envoy.extensions.transport_sockets.internal_upstream.v3.InternalUpstreamTransport",
      passthrough_metadata: [{ kind: { host: {} }, name: META }],
      transport_socket: {
        name: "envoy.transport_sockets.raw_buffer",
        typed_config: { "@type": "type.googleapis.com/envoy.extensions.transport_sockets.raw_buffer.v3.RawBuffer" },
      },
    },
  },
});

const openForwardCluster = model => ({
  name: "open-forward",
  connect_timeout: "5s",
  lb_policy: "CLUSTER_PROVIDED",
  cluster_type: {
    name: "envoy.clusters.dynamic_forward_proxy",
    typed_config: {
      "@type": "type.googleapis.com/envoy.extensions.clusters.dynamic_forward_proxy.v3.ClusterConfig",
      dns_cache_config: dnsCache(model),
    },
  },
});

const healthListener = model => ({
  name: "health",
  address: { socket_address: { address: "0.0.0.0", port_value: model.proxy.healthPort } },
  filter_chains: [{
    filters: [hcm("health", {
      name: "health",
      virtual_hosts: [{ name: "health", domains: ["*"], routes: [{ match: { path: "/ready" }, direct_response: { status: 200, body: { inline_string: "ok\n" } } }] }],
    }, [], { isolate01: "health", code: "%RESPONSE_CODE%", downstream: "%DOWNSTREAM_DIRECT_REMOTE_ADDRESS%" })],
  }],
});

export function envoyConfig(model) {
  const classes = Object.values(model.classes);
  const terminating = classes.filter(c => c.hosts.length);
  return {
    admin: { address: { socket_address: { address: "127.0.0.1", port_value: model.proxy.adminPort } } },
    bootstrap_extensions: [{
      name: "envoy.bootstrap.internal_listener",
      typed_config: { "@type": "type.googleapis.com/envoy.extensions.bootstrap.internal_listener.v3.InternalListener" },
    }],
    static_resources: {
      listeners: [outerListener(model), healthListener(model), ...terminating.map(innerListener)],
      clusters: [
        ...terminating.flatMap(cls => cls.hosts.map(host => internalCluster(cls, host))),
        ...terminatedHosts(model).map(h => upstreamCluster(h, model)),
        ...(classes.some(c => c.open) ? [openForwardCluster(model)] : []),
      ],
    },
    layered_runtime: {
      layers: [{ name: "static", static_layer: { "overload.global_downstream_max_connections": 50000 } }],
    },
  };
}

// The ENVOY_OUT chain, in order: return traffic, then refusals of new
// connections to internal addresses, then the new connections allowed, then
// everything else dropped. Each rule is iptables arguments after `-A ENVOY_OUT`.
export function envoyOutRules(model) {
  const blocked = [...BLOCKED, ...Object.values(model.classes).map(c => c.cidr), model.proxySubnet.cidr, `${model.loadBalancerAddress}/32`];
  return [
    "-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
    ...blocked.map(c => `-m conntrack --ctstate NEW -d ${c} -j REJECT`),
    "-m conntrack --ctstate NEW -p tcp -m multiport --dports 80,443 -j ACCEPT",
    ...model.proxy.resolvers.flatMap(r => [
      `-m conntrack --ctstate NEW -p udp -d ${r}/32 --dport 53 -j ACCEPT`,
      `-m conntrack --ctstate NEW -p tcp -d ${r}/32 --dport 53 -j ACCEPT`,
    ]),
    "-j DROP",
  ];
}

export function inputRules(model) {
  return [
    "-i lo -j ACCEPT",
    "-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
    ...Object.values(model.classes).map(c => `-p tcp -s ${c.cidr} --dport ${model.proxy.listenPort} -j ACCEPT`),
    ...model.proxy.healthCheckRanges.map(r => `-p tcp -s ${r} --dport ${model.proxy.healthPort} -j ACCEPT`),
    // Its own final drop, not COS's default policy.
    "-j DROP",
  ];
}

const shellQuote = s => `'${String(s).replace(/'/g, "'\\''")}'`;

function firewallScript(model) {
  const out = envoyOutRules(model);
  const input = inputRules(model);
  const uid = model.proxy.uid;
  return [
    "#!/bin/bash",
    "# ISOLATE-01: Envoy's network access (generated by deploy/egress-proxy/generate.js).",
    "set -euo pipefail",
    "iptables -w -N ENVOY_OUT 2>/dev/null || iptables -w -F ENVOY_OUT",
    ...out.map(r => `iptables -w -A ENVOY_OUT ${r}`),
    `iptables -w -C OUTPUT -m owner --uid-owner ${uid} -j ENVOY_OUT 2>/dev/null || iptables -w -I OUTPUT 1 -m owner --uid-owner ${uid} -j ENVOY_OUT`,
    "iptables -w -N EGRESS_IN 2>/dev/null || iptables -w -F EGRESS_IN",
    ...input.map(r => `iptables -w -A EGRESS_IN ${r}`),
    "iptables -w -C INPUT -j EGRESS_IN 2>/dev/null || iptables -w -I INPUT 1 -j EGRESS_IN",
    "# IPv6: nothing for Envoy, in either direction.",
    `ip6tables -w -C OUTPUT -m owner --uid-owner ${uid} -j DROP 2>/dev/null || ip6tables -w -I OUTPUT 1 -m owner --uid-owner ${uid} -j DROP`,
    "ip6tables -w -P INPUT DROP",
    "ip6tables -w -C INPUT -i lo -j ACCEPT 2>/dev/null || ip6tables -w -I INPUT 1 -i lo -j ACCEPT",
    "",
  ].join("\n");
}

// Refuses to let Envoy start unless ENVOY_OUT holds every generated rule and
// nothing else, in the generated order (return traffic, rejects, accepts,
// drop), and OUTPUT sends Envoy's UID to it first. `iptables -S` rewrites rule
// text (match order, implicit -m tcp), so rules are checked with -C and the
// order by kind, not by comparing strings.
function firewallCheckScript(model) {
  const rules = envoyOutRules(model);
  const order = "awk '{ k = /ESTABLISHED/ ? \"E\" : / -j REJECT/ ? \"R\" : / -j ACCEPT/ ? \"A\" : / -j DROP/ ? \"D\" : \"?\"; if (k != last) printf \"%s\", k; last = k }'";
  return [
    "#!/bin/bash",
    "set -euo pipefail",
    "fail() { echo \"isolate01: $1; refusing to start Envoy\" >&2; exit 1; }",
    ...rules.map(r => `iptables -w -C ENVOY_OUT ${r} || fail ${shellQuote(`ENVOY_OUT lacks: ${r}`)}`),
    "actual=$(iptables -w -S ENVOY_OUT | tail -n +2)",
    `[ "$(printf '%s\\n' "$actual" | wc -l)" -eq ${rules.length} ] || fail "ENVOY_OUT has rules that were not generated"`,
    `[ "$(printf '%s\\n' "$actual" | ${order})" = "ERAD" ] || fail "ENVOY_OUT is out of order"`,
    `[ "$(iptables -w -S OUTPUT | sed -n 2p)" = "-A OUTPUT -m owner --uid-owner ${model.proxy.uid} -j ENVOY_OUT" ] || fail "OUTPUT does not send Envoy's UID to ENVOY_OUT first"`,
    `ip6tables -w -C OUTPUT -m owner --uid-owner ${model.proxy.uid} -j DROP || fail "ip6tables does not drop Envoy's UID"`,
    ...inputRules(model).map(r => `iptables -w -C EGRESS_IN ${r} || fail ${shellQuote(`EGRESS_IN lacks: ${r}`)}`),
    `[ "$(iptables -w -S EGRESS_IN | tail -n 1)" = "-A EGRESS_IN -j DROP" ] || fail "EGRESS_IN does not end in its own DROP"`,
    `[ "$(iptables -w -S INPUT | sed -n 2p)" = "-A INPUT -j EGRESS_IN" ] || fail "INPUT does not send everything to EGRESS_IN first"`,
    "",
  ].join("\n");
}

// Runs as root, not Envoy's UID: the only process here besides the logging
// agent that reaches the metadata server.
function certFetchScript(model) {
  const hosts = terminatedHosts(model);
  return [
    "#!/bin/bash",
    "set -euo pipefail",
    "umask 077",
    `dir=${CERT_DIR}`,
    "mkdir -p \"$dir\"",
    "token=$(curl -sf -H 'Metadata-Flavor: Google' http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token | sed -n 's/.*\"access_token\": *\"\\([^\"]*\\)\".*/\\1/p')",
    "[ -n \"$token\" ] || { echo 'isolate01: no token for the certificate fetch' >&2; exit 1; }",
    "fetch() {",
    `  curl -sf -H "Authorization: Bearer $token" "https://secretmanager.googleapis.com/v1/projects/${model.project}/secrets/$1/versions/latest:access" \\`,
    "    | tr -d '\\n ' | sed -n 's/.*\"data\":\"\\([^\"]*\\)\".*/\\1/p' | base64 -d",
    "}",
    "for host in " + hosts.map(slug).join(" ") + "; do",
    "  pem=$(fetch \"egress-proxy-cert-$host\")",
    "  printf '%s\\n' \"$pem\" | sed -n '/BEGIN CERTIFICATE/,/END CERTIFICATE/p' > \"$dir/$host.crt\"",
    "  printf '%s\\n' \"$pem\" | sed -n '/BEGIN [A-Z ]*PRIVATE KEY/,/END [A-Z ]*PRIVATE KEY/p' > \"$dir/$host.key\"",
    "  [ -s \"$dir/$host.crt\" ] && [ -s \"$dir/$host.key\" ] || { echo \"isolate01: certificate for $host is incomplete\" >&2; exit 1; }",
    "done",
    `chown -R ${model.proxy.uid}:${model.proxy.uid} "$dir"`,
    "chmod 500 \"$dir\"; chmod 400 \"$dir\"/*",
    "",
  ].join("\n");
}

// The VMs' own lookups (A11). A Cloud DNS response policy binds to the whole
// VPC, proxy VMs included, so once the compiler lockdown works the metadata
// resolver answers NXDOMAIN to the image pull, the certificate fetch and the
// logging agent too. Host DNS therefore goes straight to the fixed public
// resolvers (queries sent to an outside resolver bypass the VPC's response
// policy; the proxy account's firewall already allows port 53 to them), with
// no fallback to the metadata resolver, and the metadata name pinned in
// /etc/hosts. Runs first, before anything on the VM looks up a name.
function resolverScript(model) {
  const servers = model.proxy.resolvers;
  return [
    "#!/bin/bash",
    "set -euo pipefail",
    "# Every glibc and Go client (docker, curl, the logging agent): a static resolv.conf.",
    "rm -f /etc/resolv.conf",
    `printf '%s\\n' ${servers.map(r => shellQuote(`nameserver ${r}`)).join(" ")} 'options timeout:2 attempts:2' > /etc/resolv.conf`,
    "chmod 444 /etc/resolv.conf",
    "# Anything asking systemd-resolved gets the same servers, for every domain, and no fallback.",
    "mkdir -p /etc/systemd/resolved.conf.d",
    `printf '%s\\n' '[Resolve]' ${shellQuote(`DNS=${servers.join(" ")}`)} 'FallbackDNS=' 'Domains=~.' > /etc/systemd/resolved.conf.d/isolate01.conf`,
    "if command -v resolvectl >/dev/null; then",
    "  systemctl restart systemd-resolved || true",
    "  # The DHCP-supplied metadata resolver is never a default route.",
    "  for link in $(resolvectl status --no-pager 2>/dev/null | sed -n 's/^Link [0-9]* (\\(.*\\))$/\\1/p'); do",
    "    resolvectl default-route \"$link\" no || true",
    "    resolvectl dns \"$link\" '' || true",
    "  done",
    "fi",
    "grep -qE '^169\\.254\\.169\\.254[[:space:]]+metadata\\.google\\.internal' /etc/hosts || echo '169.254.169.254 metadata.google.internal metadata' >> /etc/hosts",
    "",
  ].join("\n");
}

// Refuses to let the certificate fetch, Envoy or the report start unless host
// DNS is the fixed resolvers only, and metadata is pinned.
function resolverCheckScript(model) {
  const expected = model.proxy.resolvers.join(" ");
  return [
    "#!/bin/bash",
    "set -euo pipefail",
    "fail() { echo \"isolate01: $1; refusing to start\" >&2; exit 1; }",
    "[ ! -L /etc/resolv.conf ] || fail '/etc/resolv.conf is a symlink, not the static file'",
    `[ "$(sed -n 's/^nameserver[[:space:]]*//p' /etc/resolv.conf | tr '\\n' ' ' | sed 's/ $//')" = ${shellQuote(expected)} ] || fail 'host DNS is not exactly the fixed resolvers'`,
    "grep -qE '^169\\.254\\.169\\.254[[:space:]]+metadata\\.google\\.internal' /etc/hosts || fail 'metadata.google.internal is not pinned in /etc/hosts'",
    "",
  ].join("\n");
}

function requirePinned(model) {
  const { envoyImage, cosImage } = model.proxy;
  if (!/^[a-z0-9./-]+@sha256:[0-9a-f]{64}$/.test(envoyImage ?? "")) throw new Error("classes.json: proxy.envoyImage must be pinned by digest (rollout step 0 pins it)");
  if (!/^cos-[a-z0-9-]+$/.test(cosImage ?? "") || /^cos-(stable|beta|dev)$/.test(cosImage)) throw new Error("classes.json: proxy.cosImage must name one COS image, not a family");
}

export function cloudInit(model, envoy) {
  requirePinned(model);
  const uid = model.proxy.uid;
  const files = [
    { path: "/etc/egress-proxy/envoy.json", permissions: "0444", content: JSON.stringify(envoy, null, 2) + "\n" },
    { path: "/etc/egress-proxy/firewall.sh", permissions: "0500", content: firewallScript(model) },
    { path: "/etc/egress-proxy/firewall-check.sh", permissions: "0500", content: firewallCheckScript(model) },
    { path: "/etc/egress-proxy/fetch-certs.sh", permissions: "0500", content: certFetchScript(model) },
    { path: "/etc/egress-proxy/resolver.sh", permissions: "0500", content: resolverScript(model) },
    { path: "/etc/egress-proxy/resolver-check.sh", permissions: "0500", content: resolverCheckScript(model) },
    {
      path: "/etc/systemd/system/egress-resolver.service",
      permissions: "0444",
      content: unit({ Description: "ISOLATE-01 host DNS: the fixed resolvers only", Before: "egress-certs.service egress-envoy.service" }, { Type: "oneshot", RemainAfterExit: "yes", ExecStart: "/bin/bash /etc/egress-proxy/resolver.sh" }),
    },
    {
      path: "/etc/systemd/system/egress-firewall.service",
      permissions: "0444",
      content: unit({ Description: "ISOLATE-01 egress firewall", Before: "egress-envoy.service" }, { Type: "oneshot", RemainAfterExit: "yes", ExecStart: "/bin/bash /etc/egress-proxy/firewall.sh" }),
    },
    {
      path: "/etc/systemd/system/egress-certs.service",
      permissions: "0444",
      content: unit(
        { Description: "ISOLATE-01 certificate fetch", Requires: "egress-resolver.service", After: "network-online.target egress-resolver.service", Wants: "network-online.target", Before: "egress-envoy.service" },
        { Type: "oneshot", RemainAfterExit: "yes", ExecStartPre: "/bin/bash /etc/egress-proxy/resolver-check.sh", ExecStart: "/bin/bash /etc/egress-proxy/fetch-certs.sh" },
      ),
    },
    {
      path: "/etc/systemd/system/egress-envoy.service",
      permissions: "0444",
      content: unit(
        { Description: "ISOLATE-01 egress proxy (Envoy)", Requires: "docker.service egress-resolver.service egress-firewall.service egress-certs.service", After: "docker.service egress-resolver.service egress-firewall.service egress-certs.service" },
        {
          ExecStartPre: ["/bin/bash /etc/egress-proxy/resolver-check.sh", "/bin/bash /etc/egress-proxy/firewall-check.sh", "-/usr/bin/docker rm -f envoy"],
          // Host networking, so Envoy's packets take the host OUTPUT chain
          // where ENVOY_OUT applies by UID. Never a bridged container.
          ExecStart: [
            "/usr/bin/docker run --rm --name envoy --network host",
            `--user ${uid}:${uid} --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp`,
            "-v /etc/egress-proxy/envoy.json:/etc/envoy/envoy.json:ro",
            `-v ${CERT_DIR}:${CERT_DIR}:ro`,
            "--entrypoint /usr/local/bin/envoy",
            model.proxy.envoyImage,
            "-c /etc/envoy/envoy.json --log-format-escaped",
          ].join(" "),
          ExecStop: "/usr/bin/docker stop envoy",
          Restart: "always",
          RestartSec: "2",
        },
        { WantedBy: "multi-user.target" },
      ),
    },
  ];
  const config = {
    write_files: files,
    runcmd: [
      ["systemctl", "daemon-reload"],
      // Host DNS first: nothing below may look up a name before it's set.
      ["systemctl", "start", "egress-resolver.service"],
      ["systemctl", "start", "egress-firewall.service"],
      ["systemctl", "start", "egress-certs.service"],
      ["systemctl", "enable", "--now", "egress-envoy.service"],
    ],
  };
  // JSON is YAML; cloud-init needs only the header line.
  return "#cloud-config\n" + JSON.stringify(config, null, 2) + "\n";
}

function unit(unitSection, service, install) {
  const lines = ["[Unit]", ...section(unitSection), "", "[Service]", ...section(service)];
  if (install) lines.push("", "[Install]", ...section(install));
  return lines.join("\n") + "\n";
}
const section = obj => Object.entries(obj).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map(x => `${k}=${x}`));

// Cloud Monitoring alert policies (A9), written to out/alerts/ and created by
// infra.js's printed commands. Log-based metrics: egress-proxy-access (every
// proxy line), egress-proxy-refused (decision refuse), egress-proxy-unhealthy
// (health-check log transitions to UNHEALTHY).
export function alertPolicies(model) {
  const alerts = model.proxy.alerts ?? {};
  const metric = name => `metric.type="logging.googleapis.com/user/${name}" AND resource.type="gce_instance"`;
  const channels = alerts.notificationChannels ?? [];
  return {
    "egress-proxy-access-absent": {
      displayName: "ISOLATE-01: egress proxy access logs stopped on an instance",
      documentation: { content: "A proxy VM's access-log lines haven't arrived for 10 minutes. A broken logging path hides refusals: check the VM's logging agent (deploy/egress-proxy/README.md).", mimeType: "text/markdown" },
      combiner: "OR",
      conditions: [{
        displayName: "egress-proxy-access absent for 10 minutes, per instance",
        conditionAbsent: {
          filter: metric("egress-proxy-access"),
          duration: "600s",
          aggregations: [{ alignmentPeriod: "300s", perSeriesAligner: "ALIGN_SUM", crossSeriesReducer: "REDUCE_SUM", groupByFields: ["resource.label.instance_id"] }],
          trigger: { count: 1 },
        },
      }],
      notificationChannels: channels,
    },
    "egress-proxy-refused-spike": {
      displayName: "ISOLATE-01: egress proxy refusals above baseline",
      documentation: { content: "More refusals than the reviewed baseline: a compiler reaching for something unlisted, or a broken allowlist. Run refusals.js for the class.", mimeType: "text/markdown" },
      combiner: "OR",
      conditions: [{
        displayName: `more than ${alerts.refusedPerMinute ?? 60} refusals a minute`,
        conditionThreshold: {
          filter: metric("egress-proxy-refused"),
          comparison: "COMPARISON_GT",
          thresholdValue: alerts.refusedPerMinute ?? 60,
          duration: "300s",
          aggregations: [{ alignmentPeriod: "60s", perSeriesAligner: "ALIGN_SUM", crossSeriesReducer: "REDUCE_SUM" }],
          trigger: { count: 1 },
        },
      }],
      notificationChannels: channels,
    },
    "egress-proxy-unhealthy": {
      displayName: "ISOLATE-01: an egress proxy VM failed its health check",
      documentation: { content: "The load balancer's health check marked a proxy VM unhealthy. Autohealing replaces it; with both down, no protected compile can run.", mimeType: "text/markdown" },
      combiner: "OR",
      conditions: [{
        displayName: "any UNHEALTHY transition",
        conditionThreshold: {
          filter: metric("egress-proxy-unhealthy"),
          comparison: "COMPARISON_GT",
          thresholdValue: 0,
          duration: "0s",
          aggregations: [{ alignmentPeriod: "60s", perSeriesAligner: "ALIGN_SUM", crossSeriesReducer: "REDUCE_SUM" }],
          trigger: { count: 1 },
        },
      }],
      notificationChannels: channels,
    },
  };
}

// Every extension name used in a config, for the stable-only check.
export function extensionsUsed(config) {
  const names = new Set();
  const walk = node => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    if (typeof node.name === "string" && node.name.startsWith("envoy.") && "typed_config" in node) names.add(node.name);
    if (node.typed_extension_protocol_options) names.add("envoy.upstreams.http.http_protocol_options");
    Object.values(node).forEach(walk);
  };
  walk(config);
  return names;
}

export async function load({ deploy = path.join(ROOT, "deploy.json"), classes = path.join(HERE, "classes.json") } = {}) {
  const [d, c] = await Promise.all([readFile(deploy, "utf8"), readFile(classes, "utf8")]);
  return buildModel(JSON.parse(d), JSON.parse(c));
}

export function parseArgs(argv) {
  const opts = { deploy: undefined, classes: undefined, out: path.join(HERE, "out") };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!["--deploy", "--classes", "--out"].includes(flag) || !argv[i + 1]) throw new Error("usage: generate.js [--deploy deploy.json] [--classes classes.json] [--out dir]");
    opts[flag.slice(2)] = argv[++i];
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const model = await load(opts);
  const envoy = envoyConfig(model);
  const bad = [...extensionsUsed(envoy)].filter(n => !EXTENSIONS.has(n));
  if (bad.length) throw new Error(`unreviewed Envoy extensions: ${bad.join(", ")}`);
  await mkdir(opts.out, { recursive: true });
  await writeFile(path.join(opts.out, "envoy.json"), JSON.stringify(envoy, null, 2) + "\n");
  console.log(`wrote ${path.join(opts.out, "envoy.json")}`);
  await mkdir(path.join(opts.out, "alerts"), { recursive: true });
  for (const [name, policy] of Object.entries(alertPolicies(model))) {
    await writeFile(path.join(opts.out, "alerts", `${name}.json`), JSON.stringify(policy, null, 2) + "\n");
  }
  console.log(`wrote ${path.join(opts.out, "alerts")}/`);
  try {
    await writeFile(path.join(opts.out, "cloud-init.yaml"), cloudInit(model, envoy));
    console.log(`wrote ${path.join(opts.out, "cloud-init.yaml")}`);
  } catch (e) {
    console.log(`cloud-init.yaml not written: ${e.message}`);
  }
  for (const cls of Object.values(model.classes)) {
    console.log(`${cls.name} (${cls.cidr}${cls.open ? ", open" : ""}): ${cls.services.join(", ") || "no services"}; hosts: ${cls.hosts.join(", ") || "none"}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
