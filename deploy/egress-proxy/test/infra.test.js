import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { commands, render, parseArgs, DEFERRED } from "../infra.js";
import { load } from "../generate.js";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIXTURES = path.join(HERE, "fixtures");
const fixture = () => load({ deploy: path.join(FIXTURES, "deploy.json"), classes: path.join(FIXTURES, "classes.json") });

test("without --plan it refuses: deployment is deferred", () => {
  assert.deepEqual(parseArgs([]).plan, false);
  assert.throws(() => execFileSync(process.execPath, [path.join(HERE, "../infra.js")], { stdio: "pipe" }), e => e.stderr.toString().includes(DEFERRED));
});

test("--plan prints every step", async () => {
  const text = render(commands(await fixture()));
  for (const title of ["Compiler VPC", "Firewall: compilers", "Firewall: the proxy VMs", "DNS:", "Cloud NAT", "The proxy's identity", "Secrets:", "Instance template", "Internal passthrough Network Load Balancer", "Alerts:", "Rolling update"]) {
    assert.ok(text.includes(`# ${title}`), title);
  }
});

test("the proxy's identity gets log and metric writing and certificate secrets only", async () => {
  const text = render(commands(await fixture()));
  const roles = [...text.matchAll(/--member=serviceAccount:egress-proxy@\S+ --role=(\S+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(roles)].sort(), ["roles/logging.logWriter", "roles/monitoring.metricWriter", "roles/secretmanager.secretAccessor"]);
  const secretBindings = [...text.matchAll(/secrets add-iam-policy-binding (\S+) .*egress-proxy@/g)].map(m => m[1]);
  assert.ok(secretBindings.every(s => s.startsWith("egress-proxy-cert-")), "the proxy reads certificate secrets, not the CA bundle");
});

test("compilers are given the CA bundle and never a certificate key", async () => {
  const text = render(commands(await fixture(), { compilerAccounts: ["l0000-run@graffiticode.iam.gserviceaccount.com"] }));
  const lines = text.split("\n").filter(l => l.includes("l0000-run@"));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /add-iam-policy-binding egress-proxy-ca-bundle /);
});

test("the load balancer is internal passthrough TCP, and patching rolls one VM at a time", async () => {
  const text = render(commands(await fixture()));
  assert.match(text, /backend-services create egress-proxy .*--load-balancing-scheme=INTERNAL --protocol=TCP/);
  assert.match(text, /forwarding-rules create egress-proxy .*--address=10\.8\.0\.2 .*--ports=3128/);
  assert.match(text, /rolling-action start-update .*--max-surge=1 --max-unavailable=0/);
  assert.match(text, /cos-update-strategy=update_disabled/);
  assert.match(text, /--image=cos-121-18867-0-0 /);
});
