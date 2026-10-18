/* eslint camelcase: "off" -- Envoy's configuration API is snake_case. */
// ISOLATE-01 A25: the egress proxy's config digest. Envoy computes none of its
// own, so the generator writes two into the bootstrap's node metadata:
//   resources_sha256  over the static listeners and clusters, normalised;
//   config_sha256     over the whole bootstrap with config_sha256 left out.
// The on-VM report (envoy-config-report) recomputes resources_sha256 from the
// running Envoy's /config_dump with these same functions: their source is
// embedded in the report script, so the generator and the VM can't drift.
// Every function here is self-contained (it may call only the others here).

// JSON with sorted keys and no whitespace.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// One listener or cluster as Envoy's config dump renders it (proto JSON),
// whichever side it came from: no top-level @type (a dump entry is an Any),
// no last_updated, and none of the fields proto JSON leaves out when they hold
// their default: false, 0, "", an empty list, and the default enum values the
// generator writes (codec_type AUTO, a STATIC cluster type, an ALLOW action,
// metadata_source DYNAMIC). A private key is "[redacted]" on both sides, as the
// dump always shows it. Checked in step 0 against Envoy 1.39.4's real
// /config_dump: those two (the redaction and metadata_source) were the only
// differences.
export function normaliseResource(resource) {
  const DEFAULT_ENUMS = { codec_type: "AUTO", type: "STATIC", action: "ALLOW", metadata_source: "DYNAMIC" };
  const walk = (node, top) => {
    if (Array.isArray(node)) return node.map(n => walk(n, false));
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (top && (k === "@type" || k === "last_updated")) continue;
      if (v === false || v === 0 || v === "" || v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (DEFAULT_ENUMS[k] !== undefined && DEFAULT_ENUMS[k] === v) continue;
      if (k === "private_key") { out[k] = "[redacted]"; continue; }
      out[k] = walk(v, false);
    }
    return out;
  };
  return walk(resource, true);
}

// sha256 (hex) over the normalised listeners and clusters, each sorted by name.
// `sha256` is (text) => hex, passed in so the report can use node:crypto too.
export function resourcesDigest(listeners, clusters, sha256) {
  const byName = list => list.map(normaliseResource).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256(canonical({ clusters: byName(clusters), listeners: byName(listeners) }));
}
