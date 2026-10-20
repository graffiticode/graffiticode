// The D6 wave's check: a legacy compiler's reachable revisions must carry the egress controls.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { legacyServices, checkService, checkAll, stagingServices } from "../legacy-network-check.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const NETWORK = { network: "compilers", subnet: "compilers-default", tags: ["compiler"], proxy: "http://10.8.0.2:3128", ca: { secret: "egress-proxy-ca-bundle:1", path: "/etc/egress-ca/ca.pem" }, allow: ["api.graffiticode.org", "auth.graffiticode.org"] };
const ENV = { HTTPS_PROXY: "http://10.8.0.2:3128", HTTP_PROXY: "http://10.8.0.2:3128", NO_PROXY: "169.254.169.254,metadata.google.internal", NODE_EXTRA_CA_CERTS: "/etc/egress-ca/ca.pem", NODE_USE_ENV_PROXY: "1", AUTH_URL: "https://auth.graffiticode.org" };

const revision = ({ subnet = "compilers-default", egress = "all-traffic", env = ENV, mounted = true } = {}) => ({
  metadata: { annotations: { "run.googleapis.com/network-interfaces": JSON.stringify([{ network: "compilers", subnetwork: subnet, tags: ["compiler"] }]), ...(egress ? { "run.googleapis.com/vpc-access-egress": egress } : {}) } },
  spec: {
    containers: [{ env: Object.entries(env).map(([name, value]) => ({ name, value })), volumeMounts: mounted ? [{ name: "ca", mountPath: "/etc/egress-ca" }] : [] }],
    volumes: [{ name: "ca", secret: { secretName: "egress-proxy-ca-bundle", items: [{ key: "1", path: "ca.pem" }] } }],
  },
});
const fakeCloud = ({ traffic, revisions }) => async args => {
  if (args[1] === "services") return { status: { traffic } };
  if (args[1] === "revisions") return revisions[args[3]];
  throw new Error(`unexpected ${args.join(" ")}`);
};

test("network.json holds the 26 legacy compilers, l0137 and l0170 in the open class", async () => {
  const network = JSON.parse(await readFile(path.join(ROOT, "deploy/egress-proxy/production/network.json"), "utf8"));
  const legacy = legacyServices(network);
  assert.equal(legacy.length, 26);
  const deploy = JSON.parse(await readFile(path.join(ROOT, "deploy.json"), "utf8")).services;
  for (const s of legacy) assert.ok(!deploy[s.name], `${s.name} is legacy but in deploy.json`);
  const open = legacy.filter(s => s.network.subnet === "compilers-l0185").map(s => s.name).sort();
  assert.deepEqual(open, ["l0137", "l0170"]);
  for (const s of legacy) assert.deepEqual(s.network.allow, ["api.graffiticode.org", "auth.graffiticode.org"], s.name);
  assert.deepEqual(legacy.find(s => s.name === "l0160").forbiddenEnv, ["LEARNOSITY_KEY", "LEARNOSITY_SECRET"]);
});

test("a revision on the proxy is ready; one missing any control isn't, and every reachable revision counts", async () => {
  const svc = { name: "l0002", network: NETWORK, forbiddenEnv: [] };
  const ok = await checkService(svc, { cloud: fakeCloud({ traffic: [{ revisionName: "r1", percent: 100 }], revisions: { r1: revision() } }) });
  assert.equal(ok.ready, true, JSON.stringify(ok));
  const { NODE_USE_ENV_PROXY, ...noNodeProxy } = ENV;
  for (const [bad, expect] of [[revision({ egress: null }), /egress/], [revision({ env: noNodeProxy }), /NODE_USE_ENV_PROXY/], [revision({ mounted: false }), /ca/], [revision({ subnet: "compilers-l0185" }), /network/]]) {
    const r = await checkService(svc, { cloud: fakeCloud({ traffic: [{ revisionName: "r1", percent: 100 }], revisions: { r1: bad } }) });
    assert.equal(r.ready, false);
    assert.match(r.why.join(";"), expect);
  }
  // A tagged, unproxied revision still reachable fails it, though the serving one is ready.
  const tagged = await checkService(svc, { cloud: fakeCloud({ traffic: [{ revisionName: "r2", percent: 100 }, { revisionName: "r1", percent: 0, tag: "old" }], revisions: { r2: revision(), r1: revision({ egress: null }) } }) });
  assert.equal(tagged.ready, false);
  assert.match(tagged.why.join(";"), /^r1: /);
});

test("l0160 carrying a Learnosity variable isn't ready; a pending service doesn't fail the run", async () => {
  const l0160 = { name: "l0160", network: NETWORK, forbiddenEnv: ["LEARNOSITY_KEY", "LEARNOSITY_SECRET"] };
  const r = await checkService(l0160, { cloud: fakeCloud({ traffic: [{ revisionName: "r1", percent: 100 }], revisions: { r1: revision({ env: { ...ENV, LEARNOSITY_KEY: "k" } }) } }) });
  assert.equal(r.ready, false);
  assert.match(r.why.join(";"), /carries LEARNOSITY_KEY/);
  const unproxied = fakeCloud({ traffic: [{ revisionName: "r1", percent: 100 }], revisions: { r1: revision({ egress: null }) } });
  assert.equal((await checkAll([{ name: "l0137", network: NETWORK, forbiddenEnv: [] }], { cloud: unproxied, pending: new Set(["l0137"]) })).ok, true);
  assert.equal((await checkAll([{ name: "l0137", network: NETWORK, forbiddenEnv: [] }], { cloud: unproxied })).ok, false);
});

test("a staging service is checked against its language's class; one of a language that isn't legacy is refused", async () => {
  const legacy = [{ name: "l0170", network: { ...NETWORK, subnet: "compilers-l0185" }, forbiddenEnv: [] }, { name: "l0002", network: NETWORK, forbiddenEnv: [] }];
  const staging = stagingServices(["l0002", "l0170-feature-x", "l0002-main", "l0176", "l0176r", "api", "l0179-try"], legacy);
  assert.deepEqual(staging.map(s => [s.name, s.network?.subnet ?? null, !!s.unknown]), [["l0170-feature-x", "compilers-l0185", false], ["l0002-main", "compilers-default", false], ["l0179-try", null, true]]);
  const r = await checkService(staging[0], { cloud: fakeCloud({ traffic: [{ revisionName: "s1", percent: 100 }], revisions: { s1: revision({ subnet: "compilers-default" }) } }) });
  assert.equal(r.ready, false, "on the wrong class");
});
