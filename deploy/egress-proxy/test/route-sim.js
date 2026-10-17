/* eslint camelcase: "off" -- Envoy's configuration API is snake_case. */
// A small model of how Envoy's HTTP connection manager picks a route, for
// checking the generated config's behaviour without an Envoy binary. It follows
// Envoy's documented rules, not its code; rollout step 0 confirms it against
// the pinned Envoy (`envoy --mode validate` and the AT-11 matrix):
//   - virtual host: an exact domain first, then the longest `*.suffix`
//     wildcard, then `*`; the port is part of the host unless a domain omits it
//     and the Host has none (ignore_port_in_host_matching is off);
//   - strip_trailing_host_dot removes a trailing dot before routing, port-aware;
//   - routes in order: a CONNECT matches only `connect_matcher`, anything else
//     only path matchers; header matchers must all match;
//   - `safe_regex` must match the whole value (RE2 full match), `suffix`,
//     `prefix` and `exact` as named.

export function fullMatch(regex, value) {
  return new RegExp(`^(?:${regex})$`).test(value);
}

function stringMatch(m, value) {
  if (value === undefined) return false;
  if ("exact" in m) return value === m.exact;
  if ("prefix" in m) return value.startsWith(m.prefix);
  if ("suffix" in m) return value.endsWith(m.suffix);
  if ("contains" in m) return value.includes(m.contains);
  if ("safe_regex" in m) return fullMatch(m.safe_regex.regex, value);
  throw new Error(`route-sim: unsupported string matcher ${JSON.stringify(m)}`);
}

export function stripTrailingHostDot(authority) {
  const m = /^(.*?)\.(:\d+)?$/.exec(authority);
  return m && !authority.startsWith("[") ? m[1] + (m[2] ?? "") : authority;
}

function pickVirtualHost(virtualHosts, host) {
  const h = host.toLowerCase();
  const exact = virtualHosts.find(v => v.domains.some(d => d.toLowerCase() === h));
  if (exact) return exact;
  let best = null;
  let bestLen = -1;
  for (const v of virtualHosts) {
    for (const d of v.domains) {
      if (d.startsWith("*") && d !== "*") {
        const suffix = d.slice(1).toLowerCase();
        if (h.endsWith(suffix) && h.length > suffix.length && suffix.length > bestLen) {
          best = v;
          bestLen = suffix.length;
        }
      }
    }
  }
  return best ?? virtualHosts.find(v => v.domains.includes("*")) ?? null;
}

// request: { method: "CONNECT" | "GET" | ..., authority, path?, headers? }
// Returns { vhost, route } (route null when nothing matches: Envoy's 404).
export function routeRequest(hcmConfig, request) {
  const authority = hcmConfig.strip_trailing_host_dot ? stripTrailingHostDot(request.authority) : request.authority;
  const headers = { ...request.headers, ":authority": authority };
  const vhost = pickVirtualHost(hcmConfig.route_config.virtual_hosts, authority);
  if (!vhost) return { vhost: null, route: null, authority };
  const connect = request.method === "CONNECT";
  const route = vhost.routes.find(r => {
    const m = r.match;
    if (connect ? !("connect_matcher" in m) : "connect_matcher" in m) return false;
    if (!connect) {
      const path = request.path ?? "/";
      if ("prefix" in m && !path.startsWith(m.prefix)) return false;
      if ("path" in m && path !== m.path) return false;
    }
    return (m.headers ?? []).every(hm => stringMatch(hm.string_match, headers[hm.name]));
  }) ?? null;
  return { vhost, route, authority };
}

// What a routed request ends in: { refused: reason } or { cluster }.
export function outcome({ route }) {
  if (!route) return { refused: "no-route" };
  if (route.direct_response) {
    const h = (route.response_headers_to_add ?? []).find(x => x.header.key === "x-isolate01-refused");
    return { refused: h?.header.value ?? `status-${route.direct_response.status}` };
  }
  return { cluster: route.route.cluster };
}
