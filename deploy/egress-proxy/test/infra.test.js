import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { commands, render, parseArgs, DEFERRED, applyPlan, apply, inputProblems } from "../infra.js";
import { readFile } from "node:fs/promises";
import { alertPolicies, buildModel, load, cloudInit, envoyConfig } from "../generate.js";

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

test("every compiler behind the proxy is given the CA bundle, and never a certificate key (A9)", async () => {
  const text = render(commands(await fixture()));
  const bound = [...text.matchAll(/secrets add-iam-policy-binding egress-proxy-ca-bundle .*--member=serviceAccount:(\S+) /g)].map(m => m[1]);
  assert.deepEqual(bound, ["l0000-run@graffiticode.iam.gserviceaccount.com", "l0013-run@graffiticode.iam.gserviceaccount.com", "l0176-run@graffiticode.iam.gserviceaccount.com", "l0185-run@graffiticode.iam.gserviceaccount.com"]);
  assert.ok(!text.includes("api-run@"), "a service without a network block isn't a compiler here");
  for (const account of bound) {
    const lines = text.split("\n").filter(l => l.includes(account));
    assert.equal(lines.length, 1, account);
    assert.match(lines[0], /add-iam-policy-binding egress-proxy-ca-bundle /);
  }
  assert.doesNotMatch(text, /each compiler account|<lNNNN-run/);
});

test("a network block without a runtime account is refused", async () => {
  const classes = JSON.parse(await readFile(path.join(FIXTURES, "classes.json"), "utf8"));
  const net = { network: "compilers", subnet: "compilers-default", tags: [], proxy: "http://10.8.0.2:3128", ca: {}, allow: [] };
  assert.throws(() => buildModel({ services: { a: { network: net } } }, classes), /runtimeServiceAccount/);
});

test("the alert policies are real: the logging heartbeat, refusal spikes, unhealthy VMs (A9)", async () => {
  const model = await fixture();
  const policies = alertPolicies(model);
  assert.equal(policies["egress-proxy-access-absent"], undefined, "no absence alert on traffic: quiet hours aren't a broken path");
  const low = policies["egress-proxy-heartbeat-low"].conditions[0].conditionThreshold;
  assert.equal(low.duration, "600s");
  assert.match(low.filter, /logging\.googleapis\.com\/user\/egress-proxy-heartbeat/);
  assert.equal(low.comparison, "COMPARISON_LT");
  assert.equal(low.thresholdValue, 540, "75% of 2 VMs x 360 health lines per 5 minutes (step 0)");
  assert.equal(low.evaluationMissingData, "EVALUATION_MISSING_DATA_ACTIVE", "no data at all fires");
  assert.equal(low.aggregations[0].groupByFields, undefined, "the fleet total: a replaced VM's series doesn't fire it");
  assert.ok(render(commands(model)).includes("metrics create egress-proxy-heartbeat"));
  assert.match(policies["egress-proxy-refused-spike"].conditions[0].conditionThreshold.filter, /egress-proxy-refused/);
  assert.match(policies["egress-proxy-unhealthy"].conditions[0].conditionThreshold.filter, /egress-proxy-unhealthy/);
  const text = render(commands(model));
  for (const name of Object.keys(policies)) assert.ok(text.includes(`monitoring policies create --project=graffiticode --policy-from-file=out/alerts/${name}.json`), name);
  assert.doesNotMatch(text, /# alert policies, written in step 1/);
  assert.match(text, /logging metrics create egress-proxy-refused .*jsonPayload\.decision=/);
  assert.match(text, /health-checks create http egress-proxy-ready .*--enable-logging/);
  // DNS from Envoy's clusters must not exhaust the NAT's ports (2026-10-20).
  assert.match(text, /routers nats create egress-proxy-nat .*--min-ports-per-vm=4096 --udp-idle-timeout=10s/);
});

test("the load balancer is internal passthrough TCP, and patching rolls one VM at a time", async () => {
  const text = render(commands(await fixture()));
  assert.match(text, /backend-services create egress-proxy .*--load-balancing-scheme=INTERNAL --protocol=TCP/);
  assert.match(text, /forwarding-rules create egress-proxy .*--address=egress-proxy-lb .*--ports=3128/);
  assert.match(text, /rolling-action start-update .*--max-surge=2 --max-unavailable=0/);
  assert.match(text, /instance-groups managed create egress-proxy .*--zones=us-central1-a,us-central1-b /);
  assert.match(text, /cos-update-strategy=update_disabled/);
  assert.match(text, /--image=cos-121-18867-0-0 /);
});

test("compiler egress is matched by subnet source range, never by a network tag (A6)", async () => {
  const model = await fixture();
  const text = render(commands(model));
  assert.doesNotMatch(text, /--target-tags/, "no firewall rule depends on a tag a deployment could leave out");
  const cidrs = Object.values(model.classes).map(c => c.cidr).join(",");
  const rules = text.split("\n").filter(l => l.includes("network-firewall-policies rules create"));
  assert.equal(rules.length, 3);
  for (const r of rules) {
    assert.ok(r.includes(`--src-ip-ranges=${cidrs}`), r);
    assert.match(r, /--direction=EGRESS/);
  }
  assert.match(rules.find(r => r.includes("--action=allow")), /--layer4-configs=tcp:3128 .*--dest-ip-ranges=10\.8\.0\.2\/32/);
  assert.match(rules.find(r => r.includes("tcp:53,udp:53,tcp:853")), /--action=deny .*--enable-logging/);
  assert.match(rules.find(r => r.includes("--layer4-configs=all")), /--action=deny .*--dest-ip-ranges=0\.0\.0\.0\/0 --enable-logging/);
  assert.match(text, /network-firewall-policies associations create --firewall-policy=compilers-egress .*--network=compilers/);
  assert.match(text, /firewall-rules create egress-proxy-deny-internal .*--enable-logging/);
});

test("the group pins exactly two zones in its region, and surges by that many (A7)", async () => {
  const model = await fixture();
  for (const zones of [undefined, ["us-central1-a"], ["us-central1-a", "us-east1-b"], ["us-central1-a", "us-central1-b", "us-central1-c"]]) {
    assert.throws(() => commands({ ...model, proxy: { ...model.proxy, zones } }), /two zones/);
  }
});

// --apply: rollout step 0 only, in the scratch project.
const step0 = () => load({ deploy: path.join(HERE, "../step0/deploy.json"), classes: path.join(HERE, "../step0/classes.json") });

test("--apply refuses any project but the scratch one, production included", async () => {
  const model = await fixture();
  assert.equal(model.project, "graffiticode");
  assert.throws(() => applyPlan(model, commands(model), [1]), /runs only against graffiticode-isolate01, not graffiticode/);
  assert.throws(() => execFileSync(process.execPath, [path.join(HERE, "../infra.js"), "--apply", "--steps", "1",
    "--deploy", path.join(FIXTURES, "deploy.json"), "--classes", path.join(FIXTURES, "classes.json")], { stdio: "pipe" }),
  e => e.stderr.toString().includes("not graffiticode"));
  assert.throws(() => parseArgs(["--plan", "--apply"]));
});

test("--apply's commands are exactly --plan's, each naming the scratch project", async () => {
  const model = await step0();
  const steps = commands(model);
  const runs = applyPlan(model, steps, [1, 2, 3]);
  assert.ok(runs.length > 10);
  const printed = render(steps);
  for (const r of runs) {
    assert.ok(printed.includes(r.text), r.text);
    assert.ok(r.argv.some(a => a === "--project=graffiticode-isolate01") || r.argv[3] === "graffiticode-isolate01", r.text);
    assert.ok(!r.argv.some(a => a === "--project=graffiticode"), r.text);
  }
});

test("--apply refuses a command that names another project", async () => {
  const model = await step0();
  const steps = commands(model);
  const bad = structuredClone(steps.map(s => ({ ...s, lines: [] })));
  bad[0].lines = steps[0].lines.map(l => l);
  bad[0].lines[0].argv[bad[0].lines[0].argv.indexOf("--project=graffiticode-isolate01")] = "--project=graffiticode";
  assert.throws(() => applyPlan(model, bad, [1]), /names graffiticode, not graffiticode-isolate01/);
});

test("--apply refuses unpinned placeholders and open choices", async () => {
  const model = await step0();
  const steps = commands(model);
  const dns = steps.findIndex(s => s.title.startsWith("DNS:")) + 1;
  // Settled in step 0: the DNS step is a root private zone now, and applies.
  assert.ok(applyPlan(model, steps, [dns]).some(r => r.text.includes("managed-zones create compilers-root") && r.text.includes("--dns-name=.")));
  const open = steps.map((s, i) => i === dns - 1 ? { ...s, lines: [...s.lines, "#   gcloud dns something-undecided --project=graffiticode-isolate01"] } : s);
  assert.throws(() => applyPlan(model, open, [dns]), /open choice/);
  const template = steps.findIndex(s => s.title.startsWith("Instance template")) + 1;
  const unpinned = { ...model, proxy: { ...model.proxy, cosImage: null } };
  assert.throws(() => applyPlan(unpinned, commands(unpinned), [template]), /placeholder remains/, "an unpinned COS image");
  assert.throws(() => applyPlan(model, steps, [0]), /no step 0/);
});

test("apply runs in order, records a resource that already exists, and stops on a failure", async () => {
  const model = await step0();
  const runs = applyPlan(model, commands(model), [1]);
  const calls = [];
  const spawn = (bin, args) => {
    calls.push([bin, ...args]);
    if (calls.length === 2) return { status: 1, stderr: "ERROR: ... already exists" };
    if (calls.length === 3) return { status: 1, stderr: "ERROR: permission denied" };
    return { status: 0, stderr: "" };
  };
  assert.throws(() => apply(runs, { spawn, log: () => {}, checkInputs: () => [] }), e => {
    assert.deepEqual(e.results.map(r => r.outcome), ["ran", "exists", "failed"]);
    return true;
  });
  assert.equal(calls.length, 3, "nothing after the failure runs");
  assert.deepEqual(calls[0], runs[0].argv, "runs the argv itself, no shell");
});

test("the load balancer's address is reserved in step 1, before any VM, and the forwarding rule uses it", async () => {
  const model = await step0();
  const steps = commands(model);
  const reserve = steps[0].lines.map(String).find(l => l.includes("addresses create egress-proxy-lb"));
  assert.ok(reserve, "reserved with the subnets");
  assert.match(reserve, /--subnet=egress-proxy --addresses=10\.8\.0\.2/);
  const template = steps.findIndex(s => s.title.startsWith("Instance template"));
  assert.ok(template > 0, "VMs come later");
  const rule = render(steps).split("\n").find(l => l.includes("forwarding-rules create egress-proxy"));
  assert.match(rule, /--address=egress-proxy-lb /);
});

test("the instance group's autohealing names the regional health check by path", async () => {
  // A bare name resolves to a global health check, and the group's create
  // fails (found in step 0: ".../global/healthChecks/egress-proxy-ready does not exist").
  const text = render(commands(await step0()));
  assert.match(text, /instance-groups managed create egress-proxy .*--health-check=projects\/graffiticode-isolate01\/regions\/us-central1\/healthChecks\/egress-proxy-ready /);
  assert.match(text, /health-checks create http egress-proxy-ready .*--region=us-central1/);
});

test("apply refuses a missing or empty input file, and user-data without the template's config digest", async () => {
  const model = await step0();
  const steps = commands(model);
  const template = steps.findIndex(s => s.title.startsWith("Instance template")) + 1;
  const runs = applyPlan(model, steps, [template]);
  const digest = runs[0].argv.join(" ").match(/isolate01-config-sha256=([0-9a-f]{64})/)[1];
  const files = { "out/cloud-init.yaml": cloudInit(model, envoyConfig(model)) };
  assert.ok(files["out/cloud-init.yaml"].includes(digest));
  const fake = over => ({
    workdir: "/w",
    size: f => { const k = path.relative("/w", f); if (!(k in over)) throw new Error("ENOENT"); return over[k].length; },
    read: f => over[path.relative("/w", f)],
  });
  assert.deepEqual(inputProblems(runs, fake(files)), []);
  assert.match(inputProblems(runs, fake({}))[0], /out\/cloud-init.yaml doesn't exist/);
  assert.match(inputProblems(runs, fake({ "out/cloud-init.yaml": "" }))[0], /is empty/, "the 0-byte cloud-init found in step 0");
  assert.match(inputProblems(runs, fake({ "out/cloud-init.yaml": "#cloud-config\n" }))[0], /doesn't carry config/);
  // A stale user-data that still carries the Envoy digest but not this template's whole content.
  const stale = files["out/cloud-init.yaml"].replace("envoy-config-report", "envoy-config-reportx");
  assert.match(inputProblems(runs, fake({ "out/cloud-init.yaml": stale })).join("\n"), /isn't the user-data template egress-proxy-[0-9a-f]{12} is named for/);
  assert.throws(() => apply(runs, { spawn: () => { throw new Error("must not run"); }, log: () => {}, checkInputs: () => ["x is empty"] }), /refusing to apply/);
});

test("the template is named by its whole user-data: a host-unit change alone is a new template", async () => {
  // Found in step 0: named by the Envoy config alone, a change to a host unit kept the
  // old name, was skipped as existing, and rolled out nothing.
  const model = await step0();
  const name = m => render(commands(m)).match(/instance-templates create (egress-proxy-[0-9a-f]{12}) /)[1];
  const changed = { ...model, proxy: { ...model.proxy, reportUid: model.proxy.reportUid + 1 } };
  assert.equal(envoyConfig(changed).node.metadata.isolate01.config_sha256, envoyConfig(model).node.metadata.isolate01.config_sha256, "same Envoy config");
  assert.notEqual(name(changed), name(model), "different user-data, different template");
  assert.equal(name(model), name(await step0()), "same user-data, same name");
});

test("the config report keeps its container until the next run, so its log line ships", async () => {
  const text = cloudInit(await step0(), envoyConfig(await step0()));
  assert.ok(!text.includes("docker run --rm --name envoy-config-report"), "no --rm");
  assert.ok(text.includes("docker rm -f envoy-config-report"), "the previous run's container is removed first");
});

test("the unhealthy alert's metric is on the global resource (health-check logs are the group's)", async () => {
  // Step 0: the log-based metric from gce_instance_group entries is written against "global";
  // Monitoring refused both gce_instance and gce_instance_group filters.
  const f = alertPolicies(await fixture())["egress-proxy-unhealthy"].conditions[0].conditionThreshold.filter;
  assert.match(f, /resource\.type="global"/);
});
