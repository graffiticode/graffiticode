import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile, mkdir, rm, symlink, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs, loadConfig } from "../src/config.js";
import { included, snapshot } from "../src/snapshot.js";
import { run, streamOutput } from "../src/process.js";
import { release, rollback, traffic, buildConfig, deployArgs, smokeCheck, verifyCandidate, waitForBuild, staleTags, retireTags, meetsMilestone, belowBaseline, releaseCheck, approveReleased } from "../src/release.js";
import { createRevisionClient, decodeFields, encodeFields, reachableProblems, retainedTags } from "../src/revisions.js";

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

/**
 * @param {any} t
 * @param {{ buildFailure?: boolean, smokeFailure?: boolean, drift?: number, promotionFailure?: boolean, tags?: string[], tagFailure?: boolean }} [options]
 */
async function harness(t, { buildFailure, smokeFailure, drift, promotionFailure, tags = [], tagFailure } = {}) {
  const temp = await mkdtemp(path.join(tmpdir(), "deploy-test-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  /** @type {any} */
  const service = oldService();
  // Tags left by earlier releases, on revisions that no longer serve.
  for (const tag of tags) service.status.traffic.push({ tag, revisionName: `api-${tag}`, url: `https://${tag}---api-example.run.app` });
  let build;
  let receipt;
  let described = 0;
  // Revisions' labels, as `run revisions describe` reports them. api-old was
  // not made by this CLI.
  const revisions = new Map([["api-old", { metadata: { labels: {} } }]]);
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
      const labels = Object.fromEntries(args.find(a => a.startsWith("--labels=")).slice(9).split(",").map(kv => kv.split("=")));
      revisions.set(`api-${id}`, { metadata: { labels } });
      service.metadata.generation++;
      service.status.latestReadyRevisionName = `api-${id}`;
      service.status.traffic.push({ tag: id, revisionName: `api-${id}`, url: `https://${id}---api-example.run.app` });
      return {};
    }
    if (args[1] === "revisions" && args[2] === "describe") return structuredClone(revisions.get(args[3]) ?? { metadata: {} });
    if (args.includes("update-traffic")) {
      const remove = args.find(a => a.startsWith("--remove-tags="));
      if (remove) {
        if (tagFailure) throw new Error("tag update failed");
        const gone = remove.slice(14).split(",");
        service.status.traffic = service.status.traffic.filter(entry => !gone.includes(entry.tag));
        return {};
      }
      if (promotionFailure) throw new Error("promotion response lost");
      const targets = args.find(a => a.startsWith("--to-revisions=")).slice(15);
      // Like Cloud Run, promotion keeps every tag and moves only the percentages.
      service.status.traffic = [
        ...service.status.traffic.filter(entry => entry.tag).map(({ percent, ...entry }) => entry),
        ...targets.split(",").map(target => {
          const [revisionName, percent] = target.split("=");
          return { revisionName, percent: Number(percent) };
        })
      ];
      return {};
    }
    described++;
    if (drift === described) service.metadata.generation++;
    return structuredClone(service);
  };
  const deps = { temp, cloud, log: () => {}, save: async r => { receipt = structuredClone(r); }, smoke: async () => { if (smokeFailure) throw new Error("smoke failed"); } };
  return { deps, calls, revisions, getReceipt: () => receipt, getBuild: () => build };
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
  // The revision's identity rides with its configuration (capability plan W4).
  assert.ok(args.includes(`--update-env-vars=^|^AUTH_URL=https://example.com/a,b|GC_RELEASE=release|GC_IMAGE_DIGEST=${digest}`));
  assert.ok(!args.some(a => a.startsWith("--set-") || a.includes("allow-unauthenticated")));
  assert.ok(!args.some(a => a.startsWith("--remove-secrets")));
});

test("deploy removes listed secrets explicitly, and refuses a secret both mounted and removed", async t => {
  const args = deployArgs({ ...config, removeSecrets: ["OLD_KEY", "OTHER"] }, { id: "release", commit: source.commit, image: `image@${digest}` });
  assert.ok(args.includes("--remove-secrets=OLD_KEY,OTHER"));
  const root = await mkdtemp(path.join(tmpdir(), "deploy-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = service => writeFile(path.join(root, "deploy.json"), JSON.stringify({
    version: 1, environments: { production: { project: "graffiticode", region: "us-central1" } }, services: { api: { ...config, ...service } }
  }));
  const options = parseArgs(["--plan"]);
  await write({ removeSecrets: ["OLD_KEY"] });
  assert.deepEqual((await loadConfig(options, root, {})).config.removeSecrets, ["OLD_KEY"]);
  await write({ secrets: { OLD_KEY: "old:1" }, removeSecrets: ["OLD_KEY"] });
  await assert.rejects(loadConfig(options, root, {}), /both mounted and removed/);
  await write({ removeSecrets: [] });
  await assert.rejects(loadConfig(options, root, {}), /removeSecrets/);
  await write({ removeSecrets: ["bad-name"] });
  await assert.rejects(loadConfig(options, root, {}), /removeSecrets/);
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
    const h = await harness(t, /** @type {any} */ (settings));
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

test("a release with retireTags removes tags on non-serving revisions, keeps its own, and leaves traffic alone", async t => {
  const h = await harness(t, { tags: ["old-1", "old-2"] });
  const receipt = await release({ ...context, config: { ...config, retireTags: true } }, source, h.deps);
  assert.equal(receipt.status, "released");
  assert.deepEqual(receipt.retiredTags, ["old-1", "old-2"]);
  /** @type {any} */
  const final = await h.deps.cloud(["run", "services", "describe", "api"]);
  assert.deepEqual(final.status.traffic.filter(e => e.tag).map(e => e.tag), [receipt.id]);
  assert.deepEqual(traffic(final), { [receipt.revision]: 100 });
});

test("a release without retireTags leaves tags alone", async t => {
  const h = await harness(t, { tags: ["old-1"] });
  const receipt = await release(context, source, h.deps);
  assert.equal(receipt.retiredTags, undefined);
  assert.ok(!h.calls.some(c => c.some(a => String(a).startsWith("--remove-tags"))));
});

test("a release stays released when tag retirement fails, and records why", async t => {
  const h = await harness(t, { tags: ["old-1"], tagFailure: true });
  const receipt = await release({ ...context, config: { ...config, retireTags: true } }, source, h.deps);
  assert.equal(receipt.status, "released");
  assert.match(receipt.tagRetirementError, /tag update failed/);
  assert.equal(h.getReceipt().status, "released");
});

test("stale tags are those on revisions that serve nothing; retiring them is verified and idempotent", async t => {
  const service = {
    status: {
      traffic: [
        { revisionName: "api-new", percent: 100 },
        { tag: "new", revisionName: "api-new" },
        { tag: "old", revisionName: "api-old" },
        { tag: "keep-me", revisionName: "api-older" }
      ]
    }
  };
  assert.deepEqual(staleTags(service), ["old", "keep-me"]);
  assert.deepEqual(staleTags(service, ["keep-me"]), ["old"]);
  const h = await harness(t, { tags: ["old-1"] });
  assert.deepEqual(await retireTags(context, h.deps), ["old-1"]);
  assert.deepEqual(await retireTags(context, h.deps), []);
});

test("retire-tags parses as a command, and retireTags must be a boolean", async t => {
  assert.equal(parseArgs(["retire-tags", "policy"]).command, "retire-tags");
  const root = await mkdtemp(path.join(tmpdir(), "deploy-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "deploy.json"), JSON.stringify({
    version: 1, environments: { production: { project: "graffiticode", region: "us-central1" } }, services: { api: { ...config, retireTags: "yes" } }
  }));
  await assert.rejects(loadConfig(parseArgs(["--plan"]), root, {}), /retireTags must be a boolean/);
});

// Commit history for the provenance tests: A <- B <- C, and an unrelated X.
const A = "a".repeat(40);
const B = source.commit;
const C = "c".repeat(40);
const X = "e".repeat(40);
const parents = { [B]: A, [C]: B };
const git = {
  isAncestor: async (base, commit) => {
    for (let at = commit; at; at = parents[at]) if (at === base) return true;
    return false;
  }
};

test("each release labels its revision with its commit and whether the workspace was dirty", () => {
  assert.ok(deployArgs(config, { id: "r1-abc123", commit: B, dirty: false }).includes(`--labels=gc-release=r1-abc123,commit-sha=${B},gc-dirty=false`));
  assert.ok(deployArgs(config, { id: "r1-abc123", commit: B, dirty: true }).some(a => a.endsWith("gc-dirty=true")));
});

test("a revision meets a milestone only if built cleanly from its commit or a descendant", async () => {
  assert.equal(await meetsMilestone(git, { commit: B, dirty: "false" }, B), true);
  assert.equal(await meetsMilestone(git, { commit: C, dirty: "false" }, B), true);
  // Old code redeployed under a new release id: its commit predates the milestone.
  assert.equal(await meetsMilestone(git, { commit: A, dirty: "false" }, B), false);
  assert.equal(await meetsMilestone(git, { commit: X, dirty: "false" }, B), false);
  assert.equal(await meetsMilestone(git, { commit: C, dirty: "true" }, B), false);
  assert.equal(await meetsMilestone(git, { commit: C, dirty: null }, B), false);
  assert.equal(await meetsMilestone(git, { commit: null, dirty: "false" }, B), false);
});

const switchOff = async () => ({ policy: false, broker: false });
const withBaselines = (baselines, extra = {}) => ({ ...context, config: { ...config, baselines, ...extra } });

test("rollback below the current milestone needs --below-baseline and a verified-off switch", async t => {
  const h = await harness(t);
  const receipt = await release(context, source, h.deps);
  const guarded = withBaselines([{ milestone: "W0", commit: B }]);
  await assert.rejects(rollback(guarded, receipt, { ...h.deps, git, switchState: switchOff }), /below the W0 milestone/);
  await assert.rejects(rollback(guarded, receipt, { ...h.deps, git, allowBelowBaseline: true, switchState: async () => ({ policy: false, broker: true }) }), /must be off/);
  await assert.rejects(rollback(guarded, receipt, { ...h.deps, git, allowBelowBaseline: true }), /Cannot verify/);
  const reverted = await rollback(guarded, receipt, { ...h.deps, git, allowBelowBaseline: true, switchState: switchOff });
  assert.deepEqual(reverted.rolledBackBelowBaseline, ["api-old"]);
});

test("a service that enforces the switch never rolls back below its first milestone", async t => {
  const h = await harness(t);
  const receipt = await release(context, source, h.deps);
  const guarded = withBaselines([{ milestone: "W0", commit: B }], { enforcesSwitch: true });
  await assert.rejects(rollback(guarded, receipt, { ...h.deps, git, allowBelowBaseline: true, switchState: switchOff }), /predates the W0 milestone/);
});

test("a switch-enforcing service may roll back between milestones, below-baseline and switched off", async t => {
  const h = await harness(t);
  const first = await release(context, source, h.deps);
  const second = await release(context, { ...source, commit: C }, h.deps);
  assert.equal(second.previousTraffic[first.revision], 100);
  const guarded = withBaselines([{ milestone: "W0", commit: B }, { milestone: "W2", commit: C }], { enforcesSwitch: true });
  await assert.rejects(rollback(guarded, second, { ...h.deps, git, switchState: switchOff }), /below the W2 milestone/);
  const reverted = await rollback(guarded, second, { ...h.deps, git, allowBelowBaseline: true, switchState: switchOff });
  assert.deepEqual(reverted.rolledBackBelowBaseline, [first.revision]);
});

test("release-check fails on stale tags and on old code redeployed under a new release id", async t => {
  const h = await harness(t, { tags: ["old-1"] });
  const receipt = await release(context, source, h.deps);
  const guarded = withBaselines([{ milestone: "W0", commit: B }], { retireTags: true });
  const dirty = await releaseCheck(guarded, { ...h.deps, git });
  assert.equal(dirty.ok, false);
  assert.deepEqual(dirty.staleTags, ["old-1"]);
  assert.deepEqual(dirty.belowBaseline, []);
  await retireTags(guarded, { ...h.deps, keep: [receipt.id] });
  assert.equal((await releaseCheck(guarded, { ...h.deps, git })).ok, true);
  // A fresh release of an older commit: new release id, old code.
  await release(context, { ...source, commit: A }, h.deps);
  const old = await releaseCheck(guarded, { ...h.deps, git });
  assert.equal(old.ok, false);
  assert.equal(old.belowBaseline.length, 1);
  assert.deepEqual(await belowBaseline(guarded, ["api-old"], { ...h.deps, git }), ["api-old"]);
});

test("baselines, enforcesSwitch and protectedExecution are validated, and the new flags parse", async t => {
  assert.equal(parseArgs(["release-check", "policy", "--json"]).command, "release-check");
  assert.equal(parseArgs(["rollback", "api", "--release", "r1-abc123", "--below-baseline"])["below-baseline"], true);
  const root = await mkdtemp(path.join(tmpdir(), "deploy-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = service => writeFile(path.join(root, "deploy.json"), JSON.stringify({
    version: 1, environments: { production: { project: "graffiticode", region: "us-central1" } }, services: { api: { ...config, ...service } }
  }));
  await write({ baselines: [{ milestone: "W0", commit: B }], enforcesSwitch: true, protectedExecution: { policyUrl: "https://policy.example", brokerUrl: "https://broker.example" } });
  assert.equal((await loadConfig(parseArgs(["--plan"]), root, {})).config.baselines[0].milestone, "W0");
  for (const bad of [
    { baselines: [] },
    { baselines: [{ milestone: "W0", commit: "rmuqbq6tq-d97b10" }] },
    { baselines: [{ milestone: "W0", commit: B }, { milestone: "W0", commit: C }] },
    { baselines: { milestone: "W0", commit: B } },
    { enforcesSwitch: "yes" },
    { protectedExecution: { policyUrl: "http://policy.example", brokerUrl: "https://broker.example" } }
  ]) {
    await write(bad);
    await assert.rejects(loadConfig(parseArgs(["--plan"]), root, {}), /baselines must be|enforcesSwitch must be|protectedExecution must be/);
  }
});

// The build's status, not its log stream, decides when a build is done
// (a `gcloud builds log --stream` once outlived its successful build by an hour).
const neverEnds = () => {
  const stream = { stopped: false, done: new Promise(() => {}), stop: () => { stream.stopped = true; } };
  return stream;
};
const describing = statuses => {
  const asked = [];
  return { asked, cloud: async args => { asked.push(args); return { status: statuses[Math.min(asked.length - 1, statuses.length - 1)] }; } };
};
const noWait = async () => {};

test("a build is done when Cloud Build says so, polling until then", async () => {
  const { asked, cloud } = describing(["QUEUED", "WORKING", "WORKING", "SUCCESS"]);
  const slept = [];
  const build = await waitForBuild("build-1", { cloud, sleep: async ms => { slept.push(ms); }, pollMs: 7 });
  assert.equal(build.status, "SUCCESS");
  assert.deepEqual(asked, Array(4).fill(["builds", "describe", "build-1"]));
  assert.deepEqual(slept, [7, 7, 7]);
});

test("a log stream that never closes is stopped after the grace period, and holds nothing", async () => {
  const stream = neverEnds();
  const { cloud } = describing(["WORKING", "SUCCESS"]);
  const slept = [];
  const build = await waitForBuild("build-1", { cloud, streamLog: () => stream, sleep: async ms => { slept.push(ms); }, pollMs: 7, graceMs: 2000 });
  assert.equal(build.status, "SUCCESS");
  assert.deepEqual(slept, [7, 2000]);
  assert.equal(stream.stopped, true);
});

test("a log stream that ends lets the release go on at once; one that fails is only reported", async () => {
  const { cloud } = describing(["SUCCESS"]);
  const forever = () => new Promise(() => {});
  const ended = { done: Promise.resolve(), stop: () => {} };
  assert.equal((await waitForBuild("build-1", { cloud, streamLog: () => ended, sleep: forever })).status, "SUCCESS");
  const logged = [];
  const failing = { done: Promise.reject(new Error("gcloud builds log failed (1)")), stop: () => {} };
  const build = await waitForBuild("build-1", { cloud, streamLog: () => failing, sleep: forever, log: m => logged.push(m) });
  assert.equal(build.status, "SUCCESS");
  assert.deepEqual(logged, ["(build log stream stopped: gcloud builds log failed (1))"]);
});

test("a failed build stops its stream and deploys nothing, however the stream behaves", async t => {
  const h = await harness(t, { buildFailure: true });
  const stream = neverEnds();
  await assert.rejects(release(context, source, { ...h.deps, streamLog: () => stream, sleep: noWait }), /FAILURE; nothing deployed/);
  assert.equal(stream.stopped, true);
  assert.ok(!h.calls.some(c => c[1] === "deploy"));
});

test("a release completes past a log stream that never closes", async t => {
  const h = await harness(t);
  const stream = neverEnds();
  const receipt = await release(context, source, { ...h.deps, streamLog: () => stream, sleep: noWait });
  assert.equal(receipt.status, "released");
  assert.equal(stream.stopped, true);
  assert.ok(!h.calls.some(c => c[0] === "builds" && c[1] === "log"));
});

test("streamOutput reports a stopped command as ended, and a failing one as failed", async () => {
  const sleeper = streamOutput(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  sleeper.stop();
  await sleeper.done;
  await assert.rejects(streamOutput(process.execPath, ["-e", "process.exit(3)"]).done, /failed \(3\)/);
});

// Approved revisions (capability plan W4, section A): a pinnable service's
// releases are recorded as approved before they serve, its approved tags stay,
// and release-check covers every reachable revision.
const pinnable = { ...context, config: { ...config, pinnable: { lang: "0176" }, retireTags: true } };
const memoryRevisions = (calls = []) => {
  const records = new Map();
  return {
    records,
    fail: false,
    async approve(record) {
      calls.push(["approve", record.revision]);
      if (this.fail) throw new Error("revisions store unavailable");
      if (records.has(record.revision)) throw new Error(`Approving ${record.revision} failed: 409`);
      records.set(record.revision, structuredClone(record));
      return record;
    },
    async list() { return new Map(records); },
  };
};

test("a pinnable release is approved before it serves, with its tag, digest and commit", async t => {
  const h = await harness(t);
  const revisions = memoryRevisions(h.calls);
  const receipt = await release(pinnable, source, { ...h.deps, revisions });
  const approvedAt = h.calls.findIndex(c => c[0] === "approve");
  const promotedAt = h.calls.findIndex(c => c.some(a => String(a).startsWith("--to-revisions=")));
  assert.ok(approvedAt >= 0 && approvedAt < promotedAt, "approved before promotion");
  const record = revisions.records.get(receipt.revision);
  assert.deepEqual({ ...record, approvedAt: undefined }, {
    lang: "0176",
    service: "api",
    revision: receipt.revision,
    tag: receipt.id,
    tagUrl: `https://${receipt.id}---api-example.run.app`,
    imageDigest: digest,
    commit: source.commit,
    releaseId: receipt.id,
    contractVersions: [1],
    status: "approved",
    approvedAt: undefined,
  });
  assert.equal(receipt.approval.revision, receipt.revision);
  // Its own tag is kept; an unknown old tag is not.
  assert.deepEqual(receipt.retiredTags, []);
});

test("a pinnable release whose approval fails is never promoted", async t => {
  const h = await harness(t);
  const revisions = memoryRevisions(h.calls);
  revisions.fail = true;
  await assert.rejects(release(pinnable, source, { ...h.deps, revisions }), /revisions store unavailable/);
  assert.ok(!h.calls.some(c => c.some(a => String(a).startsWith("--to-revisions="))));
  assert.equal(h.getReceipt().status, "failed");
  await assert.rejects(release(pinnable, source, h.deps), /needs the revisions store/);
});

// A retired revision keeps its tag through retirement's wait for proofs issued
// before it (and after an interruption there): only retirement removes it.
const retirementRecords = revisions => {
  revisions.records.set("api-kept-1", { revision: "api-kept-1", status: "approved" });
  revisions.records.set("api-going-1", { revision: "api-going-1", status: "retiring" });
  revisions.records.set("api-waiting-1", { revision: "api-waiting-1", status: "retired", retiredAt: new Date().toISOString() });
  revisions.records.set("api-gone-1", { revision: "api-gone-1", status: "retired", tagRemovedAt: new Date().toISOString() });
};

test("tag retirement keeps the tags retirement still owns, and removes the rest", async t => {
  const h = await harness(t, { tags: ["kept-1", "going-1", "waiting-1", "gone-1", "unknown-1"] });
  const revisions = memoryRevisions();
  retirementRecords(revisions);
  const retired = await retireTags(pinnable, { ...h.deps, revisions });
  assert.deepEqual(retired.sort(), ["gone-1", "unknown-1"]);
  await assert.rejects(retireTags(pinnable, h.deps), /needs the revisions store/);
});

test("a release's own tag cleanup never cuts a retirement's wait short", async t => {
  const h = await harness(t, { tags: ["kept-1", "going-1", "waiting-1", "gone-1"] });
  const revisions = memoryRevisions();
  retirementRecords(revisions);
  const receipt = await release(pinnable, source, { ...h.deps, revisions });
  assert.deepEqual(receipt.retiredTags, ["gone-1"]);
});

test("release-check for a pinnable service covers every reachable revision", async t => {
  const h = await harness(t, { tags: ["held-1"] });
  const revisions = memoryRevisions();
  // Released without retiring tags, so the unknown held-1 is still reachable.
  const receipt = await release({ ...pinnable, config: { ...pinnable.config, retireTags: false } }, source, { ...h.deps, revisions });
  const guarded = { ...pinnable, config: { ...pinnable.config, baselines: [{ milestone: "W4", commit: B }] } };
  // api-held-1 is reachable by its tag and unknown to the store; api-old
  // stopped serving at promotion and has no tag, so it's unreachable.
  const first = await releaseCheck(guarded, { ...h.deps, git, revisions });
  assert.equal(first.ok, false);
  assert.deepEqual(first.revisions.reachable, ["api-held-1", receipt.revision].sort());
  assert.deepEqual(first.revisions.unapproved, ["api-held-1"]);
  assert.deepEqual(first.staleTags, ["held-1"]);
  // Approved but built from old code: a retained tag is checked against the milestone too.
  revisions.records.set("api-held-1", { revision: "api-held-1", status: "approved", contractVersions: [1] });
  const tagged = await releaseCheck(guarded, { ...h.deps, git, revisions });
  assert.deepEqual(tagged.staleTags, []);
  assert.deepEqual(tagged.belowBaseline, ["api-held-1"]);
  assert.equal(tagged.ok, false);
  for (const [status, key] of [["retiring", "retiring"], ["retired", "retired"]]) {
    revisions.records.set("api-held-1", { revision: "api-held-1", status, contractVersions: [1] });
    assert.deepEqual((await releaseCheck(guarded, { ...h.deps, git, revisions })).revisions[key], ["api-held-1"]);
  }
  const v2 = { ...guarded, config: { ...guarded.config, pinnable: { lang: "0176", minContractVersion: 2 } } };
  assert.ok((await releaseCheck(v2, { ...h.deps, git, revisions })).revisions.unsupportedContract.includes(receipt.revision));
});

test("reachable problems and retained tags are judged per revision", () => {
  const service = { status: { traffic: [{ revisionName: "s-a", percent: 100 }, { revisionName: "s-b", tag: "b" }, { revisionName: "s-c", tag: "c" }] } };
  const records = new Map([["s-a", { status: "approved", contractVersions: [1, 2] }], ["s-b", { status: "retiring", contractVersions: [1] }]]);
  assert.deepEqual(reachableProblems(service, records, { minContractVersion: 2 }), { reachable: ["s-a", "s-b", "s-c"], unapproved: ["s-c"], retiring: ["s-b"], retired: [], unsupportedContract: [] });
  assert.deepEqual(retainedTags(service, records), ["b"]);
  const retiring = new Map([["s-b", { status: "retired" }], ["s-c", { status: "retired", tagRemovedAt: "t" }]]);
  assert.deepEqual(retainedTags(service, retiring), ["b"]);
});

test("approve records a revision released before its service was pinnable, once", async t => {
  const h = await harness(t);
  const revisions = memoryRevisions();
  const receipt = await release(context, source, h.deps);
  const approved = await approveReleased(pinnable, receipt, { ...h.deps, revisions });
  assert.equal(approved.approval.status, "approved");
  assert.equal(revisions.records.get(receipt.revision).tag, receipt.id);
  await assert.rejects(approveReleased(pinnable, receipt, { ...h.deps, revisions }), /409/);
  await assert.rejects(approveReleased(pinnable, { ...receipt, status: "failed" }, { ...h.deps, revisions }), /not a released api revision/);
  await assert.rejects(approveReleased(context, receipt, { ...h.deps, revisions }), /not pinnable/);
});

test("the revisions client creates a record only if absent, and reads every page", async () => {
  const sent = [];
  const pages = [
    { documents: [{ fields: encodeFields({ revision: "l0176-a", status: "approved", contractVersions: [1] }) }], nextPageToken: "p2" },
    { documents: [{ fields: encodeFields({ revision: "l0176-b", status: "retired", contractVersions: [1, 2] }) }] },
  ];
  const firestore = async (method, resource, body) => {
    sent.push([method, resource, body]);
    return method === "GET" ? { status: 200, json: pages.shift() } : { status: 200, json: {} };
  };
  const client = createRevisionClient({ project: "graffiticode", pinnable: { lang: "0176" } }, firestore);
  await client.approve({ revision: "l0176-a", status: "approved", contractVersions: [1], approvedAt: new Date("2026-10-06T00:00:00Z") });
  assert.equal(sent[0][0], "PATCH");
  assert.equal(sent[0][1], "projects/graffiticode/databases/revisions/documents/languages/0176/revisions/l0176-a?currentDocument.exists=false");
  assert.deepEqual(decodeFields(sent[0][2].fields), { revision: "l0176-a", status: "approved", contractVersions: [1], approvedAt: "2026-10-06T00:00:00.000Z" });
  const records = await client.list();
  assert.deepEqual([...records.keys()], ["l0176-a", "l0176-b"]);
  assert.match(sent.at(-1)[1], /\?pageToken=p2$/);
  const refused = createRevisionClient({ project: "graffiticode", pinnable: { lang: "0176" } }, async () => ({ status: 409, json: { error: "exists" } }));
  await assert.rejects(refused.approve({ revision: "l0176-a" }), /409/);
});

test("pinnable is validated, and approve needs a release", async t => {
  assert.throws(() => parseArgs(["approve", "l0176"]), /approve requires --release/);
  assert.equal(parseArgs(["approve", "l0176", "--release", "r1-abc"]).command, "approve");
  const root = await mkdtemp(path.join(tmpdir(), "deploy-pinnable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async extra => writeFile(path.join(root, "deploy.json"), JSON.stringify({
    version: 1,
    environments: { production: { project: "graffiticode", region: "us-central1" } },
    services: { l0176: { ...config, service: undefined, ...extra } },
  }));
  const options = parseArgs(["l0176"]);
  for (const bad of [{ lang: "176" }, { lang: "0176", contractVersions: [] }, { lang: "0176", minContractVersion: 0 }, { lang: "0176", database: "Bad_Name" }, "0176"]) {
    await write({ pinnable: bad });
    await assert.rejects(loadConfig(options, root, {}), /pinnable must be/);
  }
  await write({ pinnable: { lang: "0176", contractVersions: [1, 2], minContractVersion: 2 } });
  assert.deepEqual((await loadConfig(options, root, {})).config.pinnable, { lang: "0176", contractVersions: [1, 2], minContractVersion: 2 });
});
