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
    model.classes[name] = { name, cidr: c.cidr, open: c.open === true, hosts: new Set(), services: [] };
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
  for (const cls of Object.values(model.classes)) cls.hosts = [...cls.hosts].sort();
  return model;
}

const denied = (host, suffixes) => suffixes.some(s => host === s || host.endsWith(`.${s}`));

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

const outerLogFields = className => ({
  isolate01: "egress",
  class: className,
  downstream: "%DOWNSTREAM_DIRECT_REMOTE_ADDRESS%",
  method: "%REQ(:METHOD)%",
  target: "%REQ(:AUTHORITY)%",
  upstream: "%UPSTREAM_REMOTE_ADDRESS%",
  upstream_cluster: "%UPSTREAM_CLUSTER%",
  code: "%RESPONSE_CODE%",
  flags: "%RESPONSE_FLAGS%",
  details: "%RESPONSE_CODE_DETAILS%",
  refused: "%RESP(X-ISOLATE01-REFUSED)%",
  bytes_in: "%BYTES_RECEIVED%",
  bytes_out: "%BYTES_SENT%",
  start: "%START_TIME%",
});

const innerLogFields = className => ({
  isolate01: "terminate",
  class: className,
  sni: "%REQUESTED_SERVER_NAME%",
  host: "%REQ(:AUTHORITY)%",
  method: "%REQ(:METHOD)%",
  path: "%REQ(:PATH)%",
  upstream: "%UPSTREAM_REMOTE_ADDRESS%",
  code: "%RESPONSE_CODE%",
  flags: "%RESPONSE_FLAGS%",
  details: "%RESPONSE_CODE_DETAILS%",
  start: "%START_TIME%",
});

const refuse = (reason) => ({
  direct_response: { status: 403, body: { inline_string: `isolate01: refused (${reason})\n` } },
  response_headers_to_add: [{ header: { key: "x-isolate01-refused", value: reason } }],
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
// this class's internal listener, carrying the target as route metadata.
const tunnelRoute = (host, className) => ({
  match: { connect_matcher: {} },
  route: { cluster: `terminate-${className}`, upgrade_configs: [{ upgrade_type: "CONNECT", connect_config: {} }] },
  metadata: { filter_metadata: { [META]: { target: host } } },
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
        { match: { connect_matcher: {}, headers: port443 }, route: { cluster: "open-forward", upgrade_configs: [{ upgrade_type: "CONNECT", connect_config: {} }] } },
        { match: { connect_matcher: {} }, ...refuse("port") },
        // Plain http, absolute form: forwarded the same way, same checks.
        { match: { prefix: "/" }, route: { cluster: "open-forward", timeout: "30s" } },
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
          { name: slug(host), domains: [host, `${host}:443`], routes: [{ match: { prefix: "/" }, route: { cluster: `upstream-${slug(host)}`, timeout: "300s" } }] },
          { name: "fronted", domains: ["*"], routes: [{ match: { prefix: "" }, ...refuse("host-mismatch") }] },
        ],
      }, [], innerLogFields(cls.name)),
    ],
  }));
  return {
    name: `terminate-${cls.name}`,
    internal_listener: {},
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

const internalCluster = cls => ({
  name: `terminate-${cls.name}`,
  type: "STATIC",
  connect_timeout: "1s",
  load_assignment: {
    cluster_name: `terminate-${cls.name}`,
    endpoints: [{ lb_endpoints: [{ endpoint: { address: { envoy_internal_address: { server_listener_name: `terminate-${cls.name}` } } } }] }],
  },
  transport_socket: {
    name: "envoy.transport_sockets.internal_upstream",
    typed_config: {
      "@type": "type.googleapis.com/envoy.extensions.transport_sockets.internal_upstream.v3.InternalUpstreamTransport",
      // The route's metadata (the CONNECT target) crosses to the internal
      // listener, where the RBAC filter checks it against the SNI.
      passthrough_metadata: [{ kind: { route: {} }, name: META }],
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
        ...terminating.map(internalCluster),
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
    {
      path: "/etc/systemd/system/egress-firewall.service",
      permissions: "0444",
      content: unit({ Description: "ISOLATE-01 egress firewall", Before: "egress-envoy.service" }, { Type: "oneshot", RemainAfterExit: "yes", ExecStart: "/bin/bash /etc/egress-proxy/firewall.sh" }),
    },
    {
      path: "/etc/systemd/system/egress-certs.service",
      permissions: "0444",
      content: unit({ Description: "ISOLATE-01 certificate fetch", After: "network-online.target", Wants: "network-online.target", Before: "egress-envoy.service" }, { Type: "oneshot", RemainAfterExit: "yes", ExecStart: "/bin/bash /etc/egress-proxy/fetch-certs.sh" }),
    },
    {
      path: "/etc/systemd/system/egress-envoy.service",
      permissions: "0444",
      content: unit(
        { Description: "ISOLATE-01 egress proxy (Envoy)", Requires: "docker.service egress-firewall.service egress-certs.service", After: "docker.service egress-firewall.service egress-certs.service" },
        {
          ExecStartPre: ["/bin/bash /etc/egress-proxy/firewall-check.sh", "-/usr/bin/docker rm -f envoy"],
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
