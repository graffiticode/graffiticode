/* eslint camelcase: "off" -- Envoy's configuration API is snake_case. */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonical, normaliseResource, resourcesDigest } from "../digest.js";
import { buildModel, cloudInit, configDigest, configReportScript, envoyConfig, load, sha256 } from "../generate.js";
import { commands, render } from "../infra.js";
import { verifyRollout } from "../verify-rollout.js";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIXTURES = path.join(HERE, "fixtures");
const fixture = () => load({ deploy: path.join(FIXTURES, "deploy.json"), classes: path.join(FIXTURES, "classes.json") });
const clone = x => JSON.parse(JSON.stringify(x));
const own = envoy => envoy.node.metadata.isolate01;

// Reverse every object's keys, all the way down.
const reorder = v => Array.isArray(v) ? v.map(reorder)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)])) : v;

// What Envoy's /config_dump would render for a resource: an Any with @type,
// keys in another order, and proto JSON's omissions (false, 0, "", empty
// lists, default enums). Step 0 compares this model with the pinned Envoy.
function protoJson(resource, type) {
  const strip = v => {
    if (Array.isArray(v)) return v.map(strip);
    if (!v || typeof v !== "object") return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === false || x === 0 || x === "" || (Array.isArray(x) && !x.length)) continue;
      if ((k === "codec_type" && x === "AUTO") || (k === "type" && x === "STATIC") || (k === "action" && x === "ALLOW")) continue;
      out[k] = strip(x);
    }
    return out;
  };
  return reorder({ "@type": type, ...strip(resource) });
}

function configDump(envoy) {
  const { listeners, clusters } = envoy.static_resources;
  return {
    configs: [
      { "@type": "type.googleapis.com/envoy.admin.v3.BootstrapConfigDump", bootstrap: clone(envoy), last_updated: "2026-10-20T10:00:00Z" },
      { "@type": "type.googleapis.com/envoy.admin.v3.ClustersConfigDump", static_clusters: [...clusters].reverse().map(c => ({ cluster: protoJson(c, "type.googleapis.com/envoy.config.cluster.v3.Cluster"), last_updated: "2026-10-20T10:00:00Z" })) },
      { "@type": "type.googleapis.com/envoy.admin.v3.ListenersConfigDump", static_listeners: listeners.map(l => ({ listener: protoJson(l, "type.googleapis.com/envoy.config.listener.v3.Listener"), last_updated: "2026-10-20T10:00:00Z" })) },
      { "@type": "type.googleapis.com/envoy.admin.v3.SecretsConfigDump" },
    ],
  };
}

// The response to ?mask=bootstrap.node.metadata: every entry kept, masked.
function maskedDump(envoy) {
  return {
    configs: [
      { "@type": "type.googleapis.com/envoy.admin.v3.BootstrapConfigDump", bootstrap: { node: { metadata: clone(envoy.node.metadata) } } },
      { "@type": "type.googleapis.com/envoy.admin.v3.ClustersConfigDump" },
      { "@type": "type.googleapis.com/envoy.admin.v3.ListenersConfigDump" },
    ],
  };
}

test("the digest is stable under key order (A25)", async () => {
  assert.equal(canonical({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: "3" } }), canonical({ a: { c: "3", d: [2, { x: 0, y: 1 }] }, b: 1 }));
  const a = envoyConfig(await fixture());
  const b = envoyConfig(await fixture());
  assert.equal(own(a).config_sha256, own(b).config_sha256);
  assert.equal(configDigest(reorder(a)), own(a).config_sha256, "configDigest ignores key order");
  const { listeners, clusters } = a.static_resources;
  assert.equal(resourcesDigest(reorder(listeners).reverse(), reorder(clusters).reverse(), sha256), own(a).resources_sha256);
  assert.match(own(a).config_sha256, /^[0-9a-f]{64}$/);
  assert.equal(configDigest(a), own(a).config_sha256, "config_sha256 is over the bootstrap with itself left out");
});

test("the digests change with any listener, cluster or route change (A25)", async () => {
  const model = await fixture();
  const base = envoyConfig(model);
  const changes = {
    route: e => { e.static_resources.listeners[0].filter_chains[0].filters[0].typed_config.route_config.virtual_hosts[0].domains.push("x.example:443"); },
    cluster: e => { e.static_resources.clusters[0].connect_timeout = "9s"; },
    listener: e => { e.static_resources.listeners[0].address.socket_address.port_value = 3130; },
    refusal: e => { e.static_resources.listeners[0].filter_chains[0].filters[0].typed_config.route_config.virtual_hosts.at(-1).routes.pop(); },
  };
  for (const [what, change] of Object.entries(changes)) {
    const e = clone(base);
    change(e);
    assert.notEqual(resourcesDigest(e.static_resources.listeners, e.static_resources.clusters, sha256), own(base).resources_sha256, what);
    assert.notEqual(configDigest(e), own(base).config_sha256, what);
  }
  // A different deploy.json (one more host) is a different config.
  const more = buildModel({ services: { a: { runtimeServiceAccount: "a-run@graffiticode.iam.gserviceaccount.com", network: { network: "compilers", subnet: "compilers-default", tags: [], proxy: "http://10.8.0.2:3128", ca: {}, allow: ["auth.graffiticode.org"] } } } },
    JSON.parse(await readFile(path.join(FIXTURES, "classes.json"), "utf8")));
  assert.notEqual(own(envoyConfig(more)).config_sha256, own(base).config_sha256);
});

test("the report's normalisation recomputes the generator's digest from a config dump (A25)", async () => {
  const envoy = envoyConfig(await fixture());
  const dump = configDump(envoy);
  const listeners = dump.configs[2].static_listeners.map(l => l.listener);
  const clusters = dump.configs[1].static_clusters.map(c => c.cluster);
  assert.ok(listeners.every(l => l["@type"]), "dump entries are Anys");
  assert.equal(resourcesDigest(listeners, clusters, sha256), own(envoy).resources_sha256);
  assert.equal(normaliseResource({ "@type": "x", last_updated: "t", name: "n", a: { last_updated: "kept below the top" } }).a.last_updated, "kept below the top");
});

test("the template and the bootstrap carry the same config digest", async () => {
  const model = await fixture();
  const envoy = envoyConfig(model);
  const text = render(commands(model));
  assert.ok(text.includes(`isolate01-config-sha256=${own(envoy).config_sha256}`));
  const config = JSON.parse(cloudInit(model, envoy).slice("#cloud-config\n".length));
  const loaded = JSON.parse(config.write_files.find(f => f.path === "/etc/egress-proxy/envoy.json").content);
  assert.equal(own(loaded).config_sha256, own(envoy).config_sha256);
  const unit = config.write_files.find(f => f.path === "/etc/systemd/system/envoy-config-report.service").content;
  assert.match(unit, /--user 10102:10102 /, "the report never runs as Envoy's UID");
  assert.match(unit, /node@sha256:1{64} node \/report\/config-report\.mjs/);
  assert.ok(config.write_files.some(f => f.path === "/etc/systemd/system/envoy-config-report.timer" && /OnUnitActiveSec=10min/.test(f.content)));
  assert.deepEqual(config.runcmd.at(-1), ["systemctl", "enable", "--now", "envoy-config-report.timer"]);
  const script = configReportScript(model);
  assert.ok(script.includes("/config_dump?mask=bootstrap.node.metadata"));
  assert.ok(!script.includes("resource=bootstrap"));
});

test("cloud-init refuses an unpinned report image", async () => {
  const model = await fixture();
  for (const reportImage of [null, "node:22"]) {
    const m = { ...model, proxy: { ...model.proxy, reportImage } };
    assert.throws(() => cloudInit(m, envoyConfig(m)), /reportImage/);
  }
});

// The report script, run as the VM runs it, against a fake Envoy admin and
// metadata server on loopback.
async function runReport(model, { bootstrapDump, fullDump, templateDigest, name = "egress-proxy-abcd" }) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
    if (req.url === "/config_dump?mask=bootstrap.node.metadata") return send(200, bootstrapDump);
    if (req.url === "/config_dump") return send(200, fullDump);
    if (req.url === "/md/name" && req.headers["metadata-flavor"] === "Google") return send(200, name);
    if (req.url === "/md/attributes/isolate01-config-sha256" && req.headers["metadata-flavor"] === "Google") return send(200, templateDigest);
    return send(404, "{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const dir = await mkdtemp(path.join(os.tmpdir(), "isolate01-report-"));
  const file = path.join(dir, "config-report.mjs");
  await writeFile(file, configReportScript(model));
  try {
    const out = await new Promise((resolve, reject) => execFile(process.execPath, [file], {
      env: { ...process.env, ISOLATE01_ADMIN: `http://127.0.0.1:${port}`, ISOLATE01_METADATA: `http://127.0.0.1:${port}/md` },
    }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
    return { line: JSON.parse(out.trim()), seen };
  } finally {
    server.close();
  }
}

test("the report logs match: true only for the expected config, read from the running Envoy (A25)", async () => {
  const model = await fixture();
  const envoy = envoyConfig(model);
  const digest = own(envoy).config_sha256;
  const good = await runReport(model, { bootstrapDump: maskedDump(envoy), fullDump: configDump(envoy), templateDigest: digest });
  assert.deepEqual({ ...good.line }, {
    isolate01: "config", instance: "egress-proxy-abcd", config_sha256: digest, resources_sha256: own(envoy).resources_sha256,
    match: true, expected_config_sha256: digest, expected_resources_sha256: own(envoy).resources_sha256,
  });
  assert.ok(good.seen.includes("/config_dump?mask=bootstrap.node.metadata"));
  assert.ok(!good.seen.some(u => u.includes("resource=")));

  // A VM still on the previous config: its bootstrap and resources are the old ones.
  const old = clone(envoy);
  old.static_resources.clusters[0].connect_timeout = "9s";
  const previous = envoyConfig({ ...model, proxy: { ...model.proxy, adminPort: 9902 } });
  const stale = await runReport(model, { bootstrapDump: maskedDump(previous), fullDump: configDump(previous), templateDigest: digest });
  assert.equal(stale.line.match, false);
  assert.equal(stale.line.config_sha256, own(previous).config_sha256);

  // Metadata carried over while the resources changed.
  const carried = await runReport(model, { bootstrapDump: maskedDump(envoy), fullDump: configDump(old), templateDigest: digest });
  assert.equal(carried.line.match, false);
  assert.notEqual(carried.line.resources_sha256, own(envoy).resources_sha256);

  // No BootstrapConfigDump entry, or no digest in it.
  const none = await runReport(model, { bootstrapDump: { configs: [{ "@type": "type.googleapis.com/envoy.admin.v3.ClustersConfigDump" }] }, fullDump: configDump(envoy), templateDigest: digest });
  assert.equal(none.line.match, false);
  assert.match(none.line.error, /no BootstrapConfigDump/);
  const bare = clone(envoy);
  delete bare.node.metadata.isolate01.config_sha256;
  const noDigest = await runReport(model, { bootstrapDump: maskedDump(bare), fullDump: configDump(envoy), templateDigest: digest });
  assert.equal(noDigest.line.match, false);
  assert.match(noDigest.line.error, /no config_sha256/);
});

const NEW = "a".repeat(64);
const OLD = "b".repeat(64);
const instance = (name, digest, created = "2026-10-20T10:00:00Z") => ({ name, creationTimestamp: created, metadata: { items: [{ key: "isolate01-config-sha256", value: digest }] } });
const report = (instanceName, at, config_sha256, match = true) => ({ timestamp: at, jsonPayload: { isolate01: "config", instance: instanceName, config_sha256, resources_sha256: "r", match } });

test("verify-rollout passes only with every VM reporting the expected digest (A25)", () => {
  const instances = [instance("egress-proxy-a", NEW), instance("egress-proxy-b", NEW)];
  const ok = verifyRollout({ expect: NEW, size: 2, instances, entries: [report("egress-proxy-a", "2026-10-20T10:05:00Z", NEW), report("egress-proxy-b", "2026-10-20T10:06:00Z", NEW)] });
  assert.equal(ok.ok, true, ok.problems.join("; "));

  const oldVm = verifyRollout({ expect: NEW, size: 2, instances: [instance("egress-proxy-a", NEW), instance("egress-proxy-b", OLD)],
    entries: [report("egress-proxy-a", "2026-10-20T10:05:00Z", NEW), report("egress-proxy-b", "2026-10-20T10:06:00Z", OLD)] });
  assert.equal(oldVm.ok, false);
  assert.ok(oldVm.problems.some(p => p.startsWith("egress-proxy-b: still running")), oldVm.problems.join("; "));

  const missing = verifyRollout({ expect: NEW, size: 2, instances, entries: [report("egress-proxy-a", "2026-10-20T10:05:00Z", NEW)] });
  assert.ok(missing.problems.some(p => p.startsWith("egress-proxy-b: no config report")));

  const mismatch = verifyRollout({ expect: NEW, size: 2, instances, entries: [report("egress-proxy-a", "2026-10-20T10:05:00Z", NEW), report("egress-proxy-b", "2026-10-20T10:06:00Z", NEW, false)] });
  assert.ok(mismatch.problems.some(p => p === "egress-proxy-b: reports match: false"));

  // A report from before the VM was (re)created doesn't count.
  const before = verifyRollout({ expect: NEW, size: 2, instances, entries: [report("egress-proxy-a", "2026-10-20T10:05:00Z", NEW), report("egress-proxy-b", "2026-10-20T09:59:00Z", NEW)] });
  assert.ok(before.problems.some(p => p.startsWith("egress-proxy-b: no config report")));

  // The latest report wins: an old good line doesn't hide a newer mismatch.
  const latest = verifyRollout({ expect: NEW, size: 2, instances, entries: [report("egress-proxy-a", "2026-10-20T10:05:00Z", NEW), report("egress-proxy-b", "2026-10-20T10:06:00Z", NEW), report("egress-proxy-b", "2026-10-20T10:16:00Z", OLD)] });
  assert.equal(latest.ok, false);

  assert.equal(verifyRollout({ expect: NEW, size: 2, instances: [instances[0]], entries: [report("egress-proxy-a", "2026-10-20T10:05:00Z", NEW)] }).ok, false, "a missing VM");
  assert.throws(() => verifyRollout({ expect: "nope", instances, entries: [] }), /--expect/);
});
