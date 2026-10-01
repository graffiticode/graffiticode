import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile, mkdir, rm, symlink, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs, loadConfig } from "../src/config.js";
import { included, snapshot } from "../src/snapshot.js";
import { run } from "../src/process.js";
import { release, rollback, traffic, buildConfig, deployArgs, smokeCheck, verifyCandidate } from "../src/release.js";

const digest = `sha256:${"a".repeat(64)}`;
const config = {
  service: "api",
  project: "graffiticode",
  region: "us-central1",
  access: "public",
  port: 3100,
  runtimeServiceAccount: "api-run@graffiticode.iam.gserviceaccount.com",
  buildServiceAccount: "build@graffiticode.iam.gserviceaccount.com",
  image: "us-central1-docker.pkg.dev/graffiticode/services/api",
  dockerfile: "Dockerfile",
  steps: [{ name: "node:22", entrypoint: "npm", args: ["ci"] }],
  env: { AUTH_URL: "https://example.com/a,b" },
  secrets: { KEY: "key:3" },
  smoke: [{ path: "/", status: 200, bodyIncludes: "OK" }],
};
const context = { config, environment: "production", configHash: "config", unresolved: [] };
const source = { commit: "b".repeat(40), sourceHash: "source", dirty: false, archive: "/tmp/archive.tar.gz", files: ["Dockerfile"] };
const oldService = () => ({
  metadata: { generation: 1 },
  spec: { template: { spec: { serviceAccountName: config.runtimeServiceAccount } } },
  status: {
    latestReadyRevisionName: "api-old", url: "https://api-example.run.app", traffic: [{ revisionName: "api-old", percent: 100 }],
  }
});

// @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
async function harness(t, { buildFailure, smokeFailure, drift, promotionFailure } = {}) {
  const temp = await mkdtemp(path.join(tmpdir(), "deploy-test-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const service = oldService();
  let build;
  let receipt;
  let described = 0;
  const calls = [];
  const cloud = async args => {
    calls.push(args);
    if (args[0] === "iam") return {};
    if (args[0] === "secrets") return { state: "ENABLED" };
    if (args.includes("get-iam-policy")) return { bindings: [{ role: "roles/run.invoker", members: ["allUsers"] }] };
    if (args[0] === "builds") {
      if (args[1] === "submit") {
        build = JSON.parse(await readFile(args.find(a => a.startsWith("--config=")).slice(9), "utf8"));
        return { id: "build-1" };
      }
      if (args[1] === "log") return "";
      return { status: buildFailure ? "FAILURE" : "SUCCESS", results: { images: [{ name: build.images[0], digest }] } };
    }
    if (args[1] === "deploy") {
      const id = args.find(a => a.startsWith("--tag=")).slice(6);
      service.metadata.generation++;
      service.status.latestReadyRevisionName = `api-${id}`;
      // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
      service.status.traffic.push({ tag: id, revisionName: `api-${id}`, url: `https://${id}---api-example.run.app` });
      return {};
    }
    if (args.includes("update-traffic")) {
      if (promotionFailure) throw new Error("promotion response lost");
      const targets = args.find(a => a.startsWith("--to-revisions=")).slice(15);
      service.status.traffic = targets.split(",").map(target => {
        const [revisionName, percent] = target.split("=");
        return { revisionName, percent: Number(percent) };
      });
      return {};
    }
    described++;
    if (drift === described) service.metadata.generation++;
    return structuredClone(service);
  };
  const deps = { temp, cloud, log: () => {}, save: async r => { receipt = structuredClone(r); }, smoke: async () => { if (smokeFailure) throw new Error("smoke failed"); } };
  return { deps, calls, getReceipt: () => receipt, getBuild: () => build };
}

test("argument parsing rejects ambiguity and missing values", () => {
  assert.deepEqual(parseArgs(["broker", "--plan"]), { command: "deploy", env: "production", config: "deploy.json", service: "broker", plan: true });
  assert.throws(() => parseArgs(["--wat"]), /Unknown/);
  assert.throws(() => parseArgs(["--env", "--plan"]), /requires a value/);
  assert.throws(() => parseArgs(["rollback", "api", "--release", "../oops"]), /requires --release/);
});

test("configuration resolves environment inputs and rejects latest secret versions", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "deploy-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // eslint-disable-next-line no-template-curly-in-string
  const raw = { version: 1, environments: { production: { project: "graffiticode", region: "us-central1" } }, services: { api: { ...config, secrets: { KEY: "key:${KEY_VERSION}" } } } };
  await writeFile(path.join(root, "deploy.json"), JSON.stringify(raw));
  const options = parseArgs(["--plan"]);
  const missing = await loadConfig(options, root, {});
  assert.deepEqual(missing.unresolved, ["KEY_VERSION"]);
  assert.equal((await loadConfig(options, root, { KEY_VERSION: "7" })).config.secrets.KEY, "key:7");
  await assert.rejects(loadConfig(options, root, { KEY_VERSION: "latest" }), /numbered version/);
});

test("build publishes with provenance and never deploys; deploy preserves unmanaged configuration", () => {
  const build = buildConfig(config, "image:release");
  assert.equal(build.options.requestedVerifyOption, "VERIFIED");
  assert.ok(!JSON.stringify(build.steps).includes("\"push\""));
  assert.ok(!JSON.stringify(build.steps).includes("\"deploy\""));
  const args = deployArgs(config, { id: "release", commit: source.commit, image: `image@${digest}` });
  assert.ok(args.includes("--no-traffic"));
  assert.ok(args.includes("--update-env-vars=^|^AUTH_URL=https://example.com/a,b"));
  assert.ok(!args.some(a => a.startsWith("--set-") || a.includes("allow-unauthenticated")));
});

test("successful release deploys the returned digest and promotes only after verification", async t => {
  const h = await harness(t);
  const receipt = await release(context, source, h.deps);
  assert.equal(receipt.status, "released");
  assert.equal(receipt.image, `${config.image}@${digest}`);
  assert.deepEqual(receipt.previousTraffic, { "api-old": 100 });
  assert.equal(receipt.buildId, "build-1");
  assert.ok(h.calls.find(c => c[1] === "deploy").includes(`--image=${receipt.image}`));
  assert.equal(h.calls.filter(c => c.includes("update-traffic")).length, 1);
  assert.equal(h.getBuild().images.length, 1);
  const reverted = await rollback(context, receipt, h.deps);
  assert.equal(reverted.status, "rolled-back");
});

for (const [label, settings, message, mayDeploy] of [
  ["failed build", { buildFailure: true }, /FAILURE/, false],
  ["failed smoke", { smokeFailure: true }, /smoke failed/, true],
  ["drift during build", { drift: 2 }, /changed during build/, false],
  ["drift during verification", { drift: 4 }, /changed during verification/, true],
]) {
  test(`${label} never promotes traffic`, async t => {
    const h = await harness(t, settings);
    // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
    await assert.rejects(release(context, source, h.deps), message);
    assert.ok(!h.calls.some(c => c.includes("update-traffic")));
    assert.equal(h.calls.some(c => c[1] === "deploy"), mayDeploy);
    assert.equal(h.getReceipt().status, "failed");
  });
}

test("ambiguous promotion failure retains a receipt with its revision and previous traffic", async t => {
  const h = await harness(t, { promotionFailure: true });
  await assert.rejects(release(context, source, h.deps), /response lost/);
  assert.equal(h.getReceipt().failedAt, "promoting");
  assert.ok(h.getReceipt().revision);
  assert.deepEqual(h.getReceipt().previousTraffic, { "api-old": 100 });
});

test("unresolved prerequisites fail before cloud calls", async t => {
  const h = await harness(t);
  await assert.rejects(release({ ...context, unresolved: ["ACCOUNT"] }, source, h.deps), /ACCOUNT/);
  await assert.rejects(release({ ...context, config: { ...config, blocked: "IAM review" } }, source, h.deps), /IAM review/);
  assert.equal(h.calls.length, 0);
});

test("rollback refuses other targets and newer traffic", async t => {
  const h = await harness(t);
  const receipt = await release(context, source, h.deps);
  await assert.rejects(rollback(context, { ...receipt, project: "other" }, h.deps), /does not match/);
  await assert.rejects(rollback(context, { ...receipt, revision: "api-stale" }, h.deps), /newer deployment/);
});

test("private smoke uses the service audience and candidate URL without following redirects", async () => {
  const service = oldService();
  // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
  service.status.traffic.push({ tag: "release", revisionName: "api-release", url: "https://release---api-example.run.app" });
  let authArgs;
  await smokeCheck({ ...config, access: "private", smokeServiceAccount: "smoke@example.com" }, service, "release", {
    cloud: async args => { authArgs = args; return "token"; },
    fetch: async (url, options) => {
      // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
      assert.equal(url.hostname, "release---api-example.run.app");
      assert.equal(options.headers["X-Serverless-Authorization"], "Bearer token");
      assert.equal(options.redirect, "error");
      return new Response("OK");
    },
  });
  // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
  assert.ok(authArgs.includes("--audiences=https://api-example.run.app"));
  // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
  await assert.rejects(smokeCheck(config, service, "release", { fetch: async () => new Response("bad", { status: 500 }) }), /got 500/);
});

test("traffic merges tagged entries and rejects incomplete allocations", () => {
  assert.deepEqual(traffic({ status: { traffic: [{ revisionName: "a", percent: 20 }, { revisionName: "b", percent: 80 }, { revisionName: "a", tag: "old" }] } }), { a: 20, b: 80 });
  assert.throws(() => traffic({ status: { traffic: [] } }), /100%/);
});

test("snapshot excludes credentials, captures dirty files and executable bits, and rejects symlinks", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "deploy-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
  const git = args => run("git", args, { cwd: root });
  await git(["init"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  await writeFile(path.join(root, "Dockerfile"), "FROM node:22\n");
  await writeFile(path.join(root, ".env"), "secret");
  await writeFile(path.join(root, "server.key"), "secret");
  await writeFile(path.join(root, ".gitignore"), ".gc-deploy/\n");
  await git(["add", "."]);
  await git(["commit", "-m", "fixture"]);
  await mkdir(path.join(root, ".claude", "worktrees"), { recursive: true });
  await writeFile(path.join(root, ".claude", "settings.local.json"), "{}");
  const first = await snapshot(root, config);
  assert.equal(first.dirty, false, "untracked always-excluded paths do not dirty a release");
  t.after(() => rm(first.dir, { recursive: true, force: true }));
  assert.ok(!first.files.includes("server.key"));
  assert.ok(!first.files.includes(".env"));
  await writeFile(path.join(root, "new file.txt"), "dirty");
  await assert.rejects(snapshot(root, config), /uncommitted/);
  const second = await snapshot(root, config, true);
  t.after(() => rm(second.dir, { recursive: true, force: true }));
  assert.notEqual(second.sourceHash, first.sourceHash);
  assert.equal(await readFile(path.join(second.dir, "source", "new file.txt"), "utf8"), "dirty");
  await chmod(path.join(root, "new file.txt"), 0o755);
  const executable = await snapshot(root, config, true);
  t.after(() => rm(executable.dir, { recursive: true, force: true }));
  assert.notEqual(executable.sourceHash, second.sourceHash);
  assert.equal((await stat(path.join(executable.dir, "source", "new file.txt"))).mode & 0o111, 0o111);
  await mkdir(path.join(root, ".gc-deploy"));
  await writeFile(path.join(root, ".gc-deploy", "release.json"), "{}");
  await symlink("Dockerfile", path.join(root, "link"));
  await assert.rejects(snapshot(root, config, true), /symlinks/);
  assert.equal(included("node_modules/foo.js"), false);
  assert.equal(included(".claude/worktrees/agent/link"), false);
  assert.equal(included("docs/readme.md", ["docs"]), false);
  assert.equal(included("languages/l0176/src/a.ts", [], ["languages/l0176", "configs/Dockerfile.l0176.yaml"]), true);
  assert.equal(included("configs/Dockerfile.l0176.yaml", [], ["languages/l0176", "configs/Dockerfile.l0176.yaml"]), true);
  assert.equal(included("languages/l0176x/a.ts", [], ["languages/l0176"]), false);
  assert.equal(included("packages/api/a.js", [], ["languages/l0176"]), false);
  assert.equal(included("languages/l0176/docs/a.md", ["languages/l0176/docs"], ["languages/l0176"]), false);
  assert.equal(included("languages/l0176/.env", [], ["languages/l0176"]), false);
});

test("wrong runtime identity and public invocation on private services fail before building", async t => {
  const h = await harness(t);
  await assert.rejects(release({ ...context, config: { ...config, runtimeServiceAccount: "other@graffiticode.iam.gserviceaccount.com" } }, source, h.deps), /Runtime identity differs/);
  await assert.rejects(release({ ...context, config: { ...config, access: "private" } }, source, h.deps), /invocation policy differs/);
  assert.ok(!h.calls.some(c => c[0] === "builds"));
});

test("disabled secret versions fail before source upload", async t => {
  const h = await harness(t);
  const original = h.deps.cloud;
  h.deps.cloud = async args => args[0] === "secrets" ? { state: "DISABLED" } : original(args);
  await assert.rejects(release(context, source, h.deps), /not enabled/);
  assert.ok(!h.calls.some(c => c[0] === "builds"));
});

// A snapshot directory holding a verify module, as snapshot() would leave it.
async function verifySource(t, body) {
  const dir = await mkdtemp(path.join(tmpdir(), "deploy-verify-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "source", "verify"), { recursive: true });
  await writeFile(path.join(dir, "source", "verify", "check.js"), body);
  return { ...source, dir, files: ["Dockerfile", "verify/check.js"] };
}
const verifyContext = { ...context, config: { ...config, verify: { module: "verify/check.js" } } };

test("verify runs the snapshot's module against the candidate before promotion, and records its hash", async t => {
  const body = "export default async ({ candidateUrl, serviceUrl, headers, log }) => log(JSON.stringify({ at: import.meta.url, candidate: candidateUrl.href, serviceUrl, headers }));\n";
  const snapshotSource = await verifySource(t, body);
  const h = await harness(t);
  const logs = [];
  h.deps.log = line => logs.push(line);
  const receipt = await release(verifyContext, snapshotSource, h.deps);
  assert.equal(receipt.status, "released");
  assert.deepEqual(receipt.verify, { module: "verify/check.js", sha256: createHash("sha256").update(body).digest("hex") });
  const seen = JSON.parse(logs.find(line => line.startsWith("{")));
  assert.ok(seen.at.startsWith(pathToFileURL(await realpath(snapshotSource.dir)).href), "module must load from the snapshot");
  assert.equal(seen.candidate, `https://${receipt.id}---api-example.run.app/`);
  assert.equal(seen.serviceUrl, "https://api-example.run.app");
  assert.deepEqual(seen.headers, {});
  const verifiedAt = logs.findIndex(line => line.startsWith("Verifying"));
  assert.ok(verifiedAt >= 0 && verifiedAt < logs.findIndex(line => line.startsWith("Promoting")));
});

test("a failing verify never promotes traffic and leaves the receipt at candidate", async t => {
  const h = await harness(t);
  const snapshotSource = await verifySource(t, "export default async () => { throw new Error(\"expected 403 unknown caller, got 200\"); };\n");
  await assert.rejects(release(verifyContext, snapshotSource, h.deps), /unknown caller, got 200/);
  assert.ok(!h.calls.some(c => c.includes("update-traffic")));
  assert.ok(h.calls.some(c => c[1] === "deploy"));
  assert.equal(h.getReceipt().status, "failed");
  assert.equal(h.getReceipt().failedAt, "candidate");
  assert.ok(h.getReceipt().verify.sha256);
  assert.deepEqual(h.getReceipt().previousTraffic, { "api-old": 100 });
});

test("verify modules must export a function and be in the snapshot", async t => {
  const h = await harness(t);
  await assert.rejects(release(verifyContext, await verifySource(t, "export const nope = 1;\n"), h.deps), /default function/);
  assert.ok(!h.calls.some(c => c.includes("update-traffic")));
  const fresh = await harness(t);
  await assert.rejects(release(verifyContext, { ...(await verifySource(t, "")), files: ["Dockerfile"] }, fresh.deps), /missing from the source snapshot/);
  assert.equal(fresh.calls.length, 0);
});

test("private verify gets the deployer's invocation header, not application credentials", async t => {
  const snapshotSource = await verifySource(t, "export default async ({ headers }) => { if (headers[\"X-Serverless-Authorization\"] !== \"Bearer token\") throw new Error(JSON.stringify(headers)); };\n");
  const service = oldService();
  // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
  service.status.traffic.push({ tag: "release", revisionName: "api-release", url: "https://release---api-example.run.app" });
  const privateConfig = { ...config, access: "private", smokeServiceAccount: "smoke@example.com", verify: { module: "verify/check.js" } };
  await verifyCandidate(privateConfig, service, "release", snapshotSource, {}, { cloud: async () => "token" });
});

test("verify.module must be a relative .js path", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "deploy-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = verify => writeFile(path.join(root, "deploy.json"), JSON.stringify({ version: 1, environments: { production: { project: "graffiticode", region: "us-central1" } }, services: { api: { ...config, verify } } }));
  for (const bad of [{ module: "../x.js" }, { module: "/abs/x.js" }, { module: "x.ts" }, "x.js", { path: "x.js" }]) {
    await write(bad);
    await assert.rejects(loadConfig(parseArgs([]), root, {}), /verify.module/);
  }
  await write({ module: "packages/api/verify/index.js" });
  assert.equal((await loadConfig(parseArgs([]), root, {})).config.verify.module, "packages/api/verify/index.js");
});
