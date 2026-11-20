import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, loadConfig } from "../src/config.js";
import { snapshot } from "../src/snapshot.js";
import { run as runCommand } from "../src/process.js";
import { deployArgs } from "../src/release.js";
import { PROFILE_CONTEXT, PROFILE_ENV, PROFILE_MOUNT, bindingEnv, bindingLabel, digestOf, fetchProfile, filesAtCommit, profileCheck, profileConfigProblems, revisionBinding } from "../src/profile.js";

/** @type {(command: string, args: string[], options?: { cwd?: string }) => Promise<any>} */
const run = /** @type {any} */ (runCommand);
const FIXTURE = fileURLToPath(new URL("./fixtures/profile-digest", import.meta.url));
// Computed by graffiticode-app's core (packages/core/src/profile/load.ts,
// profileDigest) over this directory, at graffiticode-app 7634e7e1. The app's
// own test holds core to the same value over a copy of the same fixture, so
// gc-deploy's digest and the one a running server reports can't drift apart.
const FIXTURE_DIGEST = "9098157bd1298a9319164d698e6c9949d57b30fcc85c85c683f9451855b0f64d";

const ref = "c".repeat(40);
const digest = "d".repeat(64);
const binding = { repo: "git@github.com:example/installation-a.git", ref, digest, installationId: "alpha" };

// Every file under `dir`, as core lists them (hidden ones included).
async function readTree(dir, rel = "") {
  const files = new Map();
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) for (const [k, v] of await readTree(dir, r)) files.set(k, v);
    else files.set(r, await readFile(path.join(dir, r)));
  }
  return files;
}

// A Git repository holding a copy of `from` (or nothing), committed.
/** @param {any} t @param {string | null} from @param {(dir: string) => Promise<unknown>} [edit] */
async function repoOf(t, from, edit = async () => {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "profile-repo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = args => run("git", args, { cwd: dir });
  await git(["init", "--quiet"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "core.autocrlf", "false"]);
  if (from) await cp(from, dir, { recursive: true });
  await edit(dir);
  await git(["add", "-A"]);
  await git(["commit", "--quiet", "-m", "profile"]);
  return { dir, commit: String(await git(["rev-parse", "HEAD"])) };
}

test("the digest matches core's over README, hidden, empty and binary files", async () => {
  const files = await readTree(FIXTURE);
  for (const name of ["README.md", ".hidden", ".well-known/mcp.json", "assets/logo.png", "legal/empty.txt", "a-b.txt", "a/b.txt", "B.txt"]) {
    assert.ok(files.has(name), `fixture has ${name}`);
  }
  assert.ok(files.get("assets/logo.png").includes(0x00) && files.get("assets/logo.png").includes(0xff), "the binary file has bytes that aren't text");
  assert.equal(digestOf(files), FIXTURE_DIGEST);
  // Dropping the README (as a Docker filter would) changes it.
  const withoutReadme = new Map(files);
  withoutReadme.delete("README.md");
  assert.notEqual(digestOf(withoutReadme), FIXTURE_DIGEST);
});

test("read from Git's objects, a committed profile has the same digest, byte for byte", async t => {
  const { dir, commit } = await repoOf(t, FIXTURE, async d => { await chmod(path.join(d, "a-b.txt"), 0o755); });
  const files = await filesAtCommit(dir, commit);
  assert.equal(digestOf(files), FIXTURE_DIGEST, "modes don't enter the digest");
  assert.deepEqual(files.get("assets/logo.png"), await readFile(path.join(FIXTURE, "assets/logo.png")));
});

test("fetchProfile fetches the pinned commit and binds it; a different digest is refused", async t => {
  const { dir, commit } = await repoOf(t, FIXTURE);
  const temp = await mkdtemp(path.join(tmpdir(), "profile-fetch-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const fetched = await fetchProfile({ repo: dir, ref: commit, digest: FIXTURE_DIGEST }, { temp });
  assert.deepEqual(fetched.binding, { repo: dir, ref: commit, digest: FIXTURE_DIGEST, installationId: "fixture" });
  assert.equal(fetched.files.size, (await readTree(FIXTURE)).size);
  await assert.rejects(fetchProfile({ repo: dir, ref: commit, digest }, { temp }), /isn't the reviewed/);
  assert.deepEqual(await readdir(temp), [], "the fetch's Git directory is removed");
});

test("fetchProfile refuses symlinks, non-ASCII paths, and a profile without a usable installation id", async t => {
  const temp = await mkdtemp(path.join(tmpdir(), "profile-fetch-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const fetchOf = async repo => fetchProfile({ repo: repo.dir, ref: repo.commit, digest }, { temp });
  await assert.rejects(fetchOf(await repoOf(t, FIXTURE, d => symlink("README.md", path.join(d, "link.md")))), /only regular files/);
  await assert.rejects(fetchOf(await repoOf(t, FIXTURE, d => writeFile(path.join(d, "café.txt"), "x"))), /plain ASCII/);
  await assert.rejects(fetchOf(await repoOf(t, null, d => writeFile(path.join(d, "README.md"), "x"))), /no profile.json/);
  // The digest is checked first; give these the digest they have.
  for (const body of ["{", "{\"installation\":{\"id\":\"Bad Id\"}}"]) {
    const repo = await repoOf(t, null, d => writeFile(path.join(d, "profile.json"), body));
    const actual = digestOf(await filesAtCommit(repo.dir, repo.commit));
    await assert.rejects(fetchProfile({ repo: repo.dir, ref: repo.commit, digest: actual }, { temp }), /isn't JSON|installation.id/);
  }
});

test("configuration: a profile is pinned by repo, commit and reviewed digest, and needs profileHealth", () => {
  const ok = { profile: { repo: binding.repo, ref, digest }, profileHealth: "/api/health" };
  assert.deepEqual(profileConfigProblems(ok), []);
  assert.deepEqual(profileConfigProblems({ profile: { ...ok.profile, repo: "https://github.com/example/installation-a.git" }, profileHealth: "/health" }), []);
  assert.deepEqual(profileConfigProblems({ profile: null, profileHealth: "/health" }), [], "profile-aware, released without a profile");
  assert.deepEqual(profileConfigProblems({}), [], "not profile-aware");
  const problems = over => profileConfigProblems({ ...ok, ...over }).join("; ");
  assert.match(problems({ profileHealth: undefined }), /needs profileHealth/);
  assert.match(problems({ profile: { ...ok.profile, ref: "main" } }), /full 40-hex commit/);
  assert.match(problems({ profile: { ...ok.profile, digest: undefined } }), /reviewed 64-hex/);
  assert.match(problems({ profile: { ...ok.profile, repo: "/tmp/profile" } }), /SSH or HTTPS/);
  assert.match(problems({ profile: { ...ok.profile, path: "x" } }), /\{ repo, ref, digest \}/);
  assert.match(problems({ profileHealth: "//evil.example/health" }), /local URL path/);
  assert.match(problems({ profileValidate: [] }), /non-empty command/);
});

test("configuration: the binding's variables belong to the CLI; a profile can be pinned per environment", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "profile-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = {
    image: "us-central1-docker.pkg.dev/p/services/console",
    dockerfile: "Dockerfile",
    port: 8080,
    access: "public",
    runtimeServiceAccount: "run@p.iam.gserviceaccount.com",
    buildServiceAccount: "build@p.iam.gserviceaccount.com",
    steps: [{ name: "node:22", args: ["ci"] }],
    smoke: [{ path: "/", status: 200 }],
    profileHealth: "/api/health",
  };
  const write = (svc, envs = { production: { project: "p", region: "us-central1" } }) => writeFile(path.join(root, "deploy.json"), JSON.stringify({ version: 1, environments: envs, services: { console: svc } }));
  await write(service, { production: { project: "p", region: "us-central1" }, alpha: { project: "p", region: "us-central1", profile: { repo: binding.repo, ref, digest } } });
  assert.equal((await loadConfig(parseArgs(["console"]), root)).config.profile, undefined);
  assert.deepEqual((await loadConfig(parseArgs(["console", "--env", "alpha"]), root)).config.profile, { repo: binding.repo, ref, digest });
  for (const name of PROFILE_ENV) {
    await write({ ...service, env: { [name]: "x" } });
    await assert.rejects(loadConfig(parseArgs(["console"]), root), /set by the deploy CLI/);
    await write({ ...service, removeEnv: [name] });
    await assert.rejects(loadConfig(parseArgs(["console"]), root), /set by the deploy CLI/);
  }
  await write({ ...service, profileHealth: undefined, profile: { repo: binding.repo, ref, digest } });
  await assert.rejects(loadConfig(parseArgs(["console"]), root), /needs profileHealth/);
});

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), "profile-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = args => run("git", args, { cwd: root });
  await git(["init", "--quiet"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  await writeFile(path.join(root, "Dockerfile"), "FROM node:22\n");
  await writeFile(path.join(root, ".gitignore"), ".gc-deploy/\n");
  await git(["add", "."]);
  await git(["commit", "--quiet", "-m", "fixture"]);
  return { root, git };
}
const aware = { dockerfile: "Dockerfile", profileHealth: "/api/health" };

test("the snapshot carries every profile byte under the reserved path, outside the workspace's filters", async t => {
  const { root } = await workspace(t);
  const files = await readTree(FIXTURE);
  // Names the workspace snapshot itself would drop.
  files.set(".env", Buffer.from("PUBLIC=1\n"));
  files.set("certs/ca.pem", Buffer.from("-----BEGIN CERTIFICATE-----\n"));
  const plain = await snapshot(root, { dockerfile: "Dockerfile" });
  t.after(() => rm(plain.dir, { recursive: true, force: true }));
  const empty = await snapshot(root, aware);
  t.after(() => rm(empty.dir, { recursive: true, force: true }));
  const withProfile = await snapshot(root, aware, false, files);
  t.after(() => rm(withProfile.dir, { recursive: true, force: true }));
  assert.equal(empty.sourceHash, plain.sourceHash, "an empty profile directory adds nothing to the hash");
  assert.deepEqual(await readdir(path.join(empty.dir, "source", PROFILE_CONTEXT)), []);
  await assert.rejects(readdir(path.join(plain.dir, "source", PROFILE_CONTEXT)), /ENOENT/, "a service that isn't profile-aware gets no directory");
  assert.notEqual(withProfile.sourceHash, plain.sourceHash);
  const carried = await readTree(path.join(withProfile.dir, "source", PROFILE_CONTEXT));
  assert.deepEqual([...carried.keys()].sort(), [...files.keys()].sort());
  for (const [rel, data] of files) assert.deepEqual(carried.get(rel), data, rel);
  assert.ok(withProfile.files.includes(`${PROFILE_CONTEXT}/README.md`));
  await assert.rejects(snapshot(root, { dockerfile: "Dockerfile" }, false, files), /profile-aware/);
});

test("a workspace may not contain the reserved profile path, in any form", async t => {
  const cases = {
    committed: async (root, git) => {
      await mkdir(path.join(root, PROFILE_CONTEXT));
      await writeFile(path.join(root, PROFILE_CONTEXT, "profile.json"), "{}");
      await git(["add", "."]);
      await git(["commit", "--quiet", "-m", "reserved"]);
    },
    "empty directory": root => mkdir(path.join(root, PROFILE_CONTEXT)),
    "Git-ignored files": async root => {
      await writeFile(path.join(root, ".gitignore"), ".gc-deploy/\n.gc-profile/\n");
      await mkdir(path.join(root, PROFILE_CONTEXT));
      await writeFile(path.join(root, PROFILE_CONTEXT, "profile.json"), "{}");
    },
    file: root => writeFile(path.join(root, PROFILE_CONTEXT), "x"),
    symlink: async root => {
      await mkdir(path.join(root, "elsewhere"));
      await symlink("elsewhere", path.join(root, PROFILE_CONTEXT));
    },
    "dangling symlink": root => symlink("missing", path.join(root, PROFILE_CONTEXT)),
  };
  for (const [name, make] of Object.entries(cases)) {
    const { root, git } = await workspace(t);
    await make(root, git);
    await assert.rejects(snapshot(root, aware, true), /reserved for the release's profile/, name);
  }
  // A service that isn't profile-aware never uses the path.
  const { root } = await workspace(t);
  await mkdir(path.join(root, PROFILE_CONTEXT));
  const plain = await snapshot(root, { dockerfile: "Dockerfile" });
  await rm(plain.dir, { recursive: true, force: true });
});

const base = {
  service: "console",
  port: 8080,
  image: "i",
  runtimeServiceAccount: "run@p.iam.gserviceaccount.com",
  smoke: [{ path: "/", status: 200, timeoutMs: 240000 }],
};
const receiptOf = profile => ({ id: "r1", commit: "b".repeat(40), dirty: false, image: `i@sha256:${"a".repeat(64)}`, ...(profile !== undefined ? { profile } : {}) });
const flag = (args, name) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);

test("deploy arguments bind the revision, or unbind a profile-aware one released without a profile", () => {
  const bound = deployArgs({ ...base, profileHealth: "/api/health" }, receiptOf(binding));
  assert.match(flag(bound, "labels"), new RegExp(`,gc-profile=${bindingLabel(binding)}$`));
  for (const [name, value] of Object.entries(bindingEnv(binding))) assert.ok(flag(bound, "update-env-vars").includes(`${name}=${value}`), name);
  assert.equal(bindingEnv(binding).PROFILE_DIR, PROFILE_MOUNT);
  assert.equal(flag(bound, "remove-labels"), undefined);
  assert.equal(flag(bound, "remove-env-vars"), undefined);
  const unbound = deployArgs({ ...base, profileHealth: "/api/health", removeEnv: ["OLD"] }, receiptOf(null));
  assert.deepEqual(flag(unbound, "remove-env-vars").split(","), ["OLD", ...PROFILE_ENV]);
  assert.equal(flag(unbound, "remove-labels"), "gc-profile");
  assert.ok(!flag(unbound, "labels").includes("gc-profile"));
  // A service that isn't profile-aware deploys exactly as before.
  const plain = deployArgs(base, receiptOf(undefined));
  assert.ok(!plain.some(a => a.includes("gc-profile") || a.includes("PROFILE_")));
});

const revisionWith = (env, labels = {}) => ({ metadata: { labels }, spec: { containers: [{ env: Object.entries(env).map(([name, value]) => ({ name, value })) }] } });

test("a revision's binding is read from its own environment: bound, none, partial or unreadable", () => {
  assert.deepEqual(revisionBinding(revisionWith({ ...bindingEnv(binding), OTHER: "1" }, { "gc-profile": bindingLabel(binding) })), { state: "bound", binding });
  assert.deepEqual(revisionBinding(revisionWith({ OTHER: "1" })), { state: "none", binding: null });
  assert.equal(revisionBinding(revisionWith({ PROFILE_DIR: "/somewhere" })).state, "partial");
  assert.equal(revisionBinding(revisionWith(bindingEnv(binding))).state, "partial", "the label is part of the binding");
  assert.equal(revisionBinding(revisionWith({ ...bindingEnv(binding), PROFILE_DIR: "/other" }, { "gc-profile": bindingLabel(binding) })).state, "partial");
  assert.equal(revisionBinding({ metadata: {} }).state, "unreadable");
  assert.deepEqual(revisionBinding(revisionWith({ OTHER: "1" }, { "gc-profile": bindingLabel(binding) })), { state: "partial", present: ["label gc-profile"] }, "the label alone isn't \"none\"");
});

const access = { base: new URL("https://r1---console-x.run.app"), headers: { "X-Serverless-Authorization": "Bearer t" } };
const answering = (status, body, seen = []) => async (url, init) => {
  seen.push({ url: String(url), init });
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
};
const receiptFor = (b, over = {}) => ({ appVersion: "console-r1", installationId: b.installationId, profileVersion: 1, profileRepo: b.repo, profileRef: b.ref, profileDigest: b.digest, ...over });
const awareConfig = { ...base, profileHealth: "/api/health" };

test("the profile check reads the candidate's receipt with the smoke checks' safeguards", async () => {
  const seen = [];
  await profileCheck(awareConfig, access, "console-r1", binding, { fetch: answering(200, { ok: true, installation: receiptFor(binding) }, seen) });
  assert.equal(seen[0].url, "https://r1---console-x.run.app/api/health");
  assert.equal(seen[0].init.redirect, "error");
  assert.deepEqual(seen[0].init.headers, access.headers);
  assert.ok(seen[0].init.signal instanceof AbortSignal);
  await profileCheck(awareConfig, access, "console-r1", null, { fetch: answering(200, { ok: true }) });
});

test("the profile check refuses any difference in the complete receipt", async () => {
  const check = (body, b = binding, status = 200) => profileCheck(awareConfig, access, "console-r1", b, { fetch: answering(status, body) });
  for (const [field, value] of [["appVersion", "console-r0"], ["appVersion", "dev"], ["installationId", "beta"], ["profileRepo", "git@github.com:example/installation-b.git"], ["profileRef", "e".repeat(40)], ["profileDigest", "f".repeat(64)]]) {
    await assert.rejects(check({ installation: receiptFor(binding, { [field]: value }) }), new RegExp(`differs in ${field}`), field);
  }
  await assert.rejects(check({ ok: true }), /reports no installation receipt/);
  await assert.rejects(check({ installation: receiptFor(binding) }, null), /released without a profile/);
  await assert.rejects(check({}, binding, 503), /expected 200, got 503/);
  await assert.rejects(check("<html>"), /not JSON/);
});

test("an unreadable revision with a profile label remains a known partial binding", () => {
  for (const spec of [undefined, { containers: [] }]) {
    assert.deepEqual(revisionBinding({ metadata: { labels: { "gc-profile": bindingLabel(binding) } }, spec }),
      { state: "partial", present: ["label gc-profile"] });
  }
  assert.deepEqual(revisionBinding({ metadata: { labels: {} } }), { state: "unreadable" });
});
