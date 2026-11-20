// Installation profiles (graffiticode-app, docs/installations-plan.md D-I4):
// a release fetches the profile `deploy.json` pins, checks it against the
// reviewed digest, builds it into the image, and binds the revision to it.
//
// The binding is {repo, ref, digest, installationId}. It is recorded in the
// receipt, and on the revision itself as managed environment variables (and a
// short label), so read-only checks, promotion and rollback read it from Cloud
// Run without a local receipt and without fetching anything.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { requireValue } from "./config.js";
import { run } from "./process.js";

// `run`, typed for this module's calls (its options are all optional).
/** @type {(command: string, args: string[], options?: { cwd?: string, raw?: boolean, binary?: boolean }) => Promise<any>} */
const exec = /** @type {any} */ (run);

// Where the snapshot carries the profile, and where the image puts it. The
// workspace may not contain the reserved path; the Dockerfile copies it to the
// mount (and must exempt it from .dockerignore, which would otherwise drop
// files the digest covers, README.md and .env* among them).
export const PROFILE_CONTEXT = ".gc-profile";
export const PROFILE_MOUNT = "/gc-profile";
// The binding on the revision. PROFILE_DIR, PROFILE_REPO and PROFILE_REF are
// what the app's runtime reads (core/src/profile/runtime.ts); the other two
// complete the binding. All five are set by the CLI, never by a service, and a
// profile-aware service released without a profile has all five removed.
export const PROFILE_ENV = Object.freeze(["PROFILE_DIR", "PROFILE_REPO", "PROFILE_REF", "GC_PROFILE_DIGEST", "GC_PROFILE_INSTALLATION"]);
export const PROFILE_LABEL = "gc-profile";

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const INSTALLATION_ID = /^[a-z][a-z0-9-]{0,62}$/;
// SSH (scp-like or ssh://) or HTTPS; never a local path or another transport.
const REPO = /^(?:git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+\.git|ssh:\/\/git@[A-Za-z0-9.-]+\/[A-Za-z0-9._/-]+\.git|https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._/-]+\.git)$/;
// Profile paths are plain ASCII, so the digest can't depend on how a
// filesystem normalizes a name.
const SAFE_PATH = /^[\x21-\x7e]+(?:\/[\x21-\x7e]+)*$/;

const object = value => value && typeof value === "object" && !Array.isArray(value);

// deploy.json's `profile` (null: none) and `profileHealth`, `profileValidate`.
// A service with neither `profile` nor `profileHealth` isn't profile-aware and
// releases exactly as before.
export function profileConfigProblems(config) {
  const problems = [];
  const { profile, profileHealth, profileValidate } = config;
  if (profile !== undefined && profile !== null) {
    if (!object(profile) || Object.keys(profile).some(k => !["repo", "ref", "digest"].includes(k))) problems.push("profile must be { repo, ref, digest } or null");
    else {
      if (typeof profile.repo !== "string" || !REPO.test(profile.repo)) problems.push("profile.repo must be an SSH or HTTPS Git URL ending in .git");
      if (typeof profile.ref !== "string" || !SHA1.test(profile.ref)) problems.push("profile.ref must be a full 40-hex commit (no branch or tag names)");
      if (typeof profile.digest !== "string" || !SHA256.test(profile.digest)) problems.push("profile.digest must be the reviewed 64-hex profile digest");
    }
    if (profileHealth === undefined) problems.push("a profile needs profileHealth, the path where the candidate reports its installation receipt");
  }
  if (profileHealth !== undefined && !(typeof profileHealth === "string" && profileHealth.startsWith("/") && !profileHealth.startsWith("//") && !profileHealth.includes("\\"))) {
    problems.push("profileHealth must be a local URL path");
  }
  if (profileValidate !== undefined && !(Array.isArray(profileValidate) && profileValidate.length > 0 && profileValidate.every(a => typeof a === "string" && a.length > 0))) {
    problems.push("profileValidate must be a non-empty command array; the profile's directory is appended");
  }
  return problems;
}

export const profileAware = config => config.profileHealth !== undefined;
export const selectedProfile = config => (config.profile ? config.profile : null);

// The digest, as core computes it (core/src/profile/load.ts, profileDigest):
// sha256 over JSON.stringify of [[path, sha256(content)], ...] in sorted path
// order (JavaScript's default sort, over full "/"-separated paths). The
// cross-implementation fixture (test/fixtures/profile-digest) holds both to it.
export function digestOf(files) {
  const manifest = [...files.keys()].sort().map(rel => [rel, createHash("sha256").update(files.get(rel)).digest("hex")]);
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

// Reads every file of a commit straight from Git's objects: the committed
// bytes, with no checkout filter or line-ending conversion. Only regular files
// (100644, 100755); a symlink or submodule is refused, as core refuses them.
export async function filesAtCommit(gitDir, commit) {
  const listing = await exec("git", ["ls-tree", "-r", "-z", "--full-tree", commit], { cwd: gitDir, raw: true });
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  for (const entry of String(listing).split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, type, oid] = entry.slice(0, tab).split(" ");
    const rel = entry.slice(tab + 1);
    requireValue(type === "blob" && (mode === "100644" || mode === "100755"), `Profile ${rel}: only regular files are supported (found ${type} ${mode})`);
    requireValue(SAFE_PATH.test(rel) && !rel.split("/").some(p => p === "." || p === ".."), `Profile path ${JSON.stringify(rel)} must be plain ASCII`);
    files.set(rel, await exec("git", ["cat-file", "blob", oid], { cwd: gitDir, binary: true }));
  }
  return files;
}

// Fetches exactly the pinned commit (never a branch), reads its files, and
// checks them against the reviewed digest. Contacts the repo's host (SSH
// access for an SSH URL). `repo` may be a local path only in tests.
/** @param {{ repo: string, ref: string, digest: string }} profile @param {{ temp?: string, log?: (message: string) => void }} options */
export async function fetchProfile(profile, { temp, log = () => {} }) {
  const gitDir = await mkdtemp(path.join(temp ?? tmpdir(), "gc-profile-"));
  try {
    log(`Fetching profile ${profile.repo} at ${profile.ref}…`);
    await exec("git", ["init", "--quiet", "--bare"], { cwd: gitDir });
    await exec("git", ["fetch", "--quiet", "--no-tags", "--depth=1", profile.repo, profile.ref], { cwd: gitDir });
    const fetched = String(await exec("git", ["rev-parse", "FETCH_HEAD^{commit}"], { cwd: gitDir })).trim();
    requireValue(fetched === profile.ref, `Fetched ${fetched}, not the pinned ${profile.ref}`);
    const files = await filesAtCommit(gitDir, profile.ref);
    requireValue(files.has("profile.json"), "The pinned commit has no profile.json");
    const digest = digestOf(files);
    requireValue(digest === profile.digest, `Profile digest ${digest} at ${profile.ref} isn't the reviewed ${profile.digest}; review the profile and update deploy.json. Nothing built.`);
    /** @type {any} */
    let parsed;
    try { parsed = JSON.parse(files.get("profile.json").toString("utf8")); } catch { requireValue(false, "The profile's profile.json isn't JSON"); }
    const installationId = parsed?.installation?.id;
    requireValue(typeof installationId === "string" && INSTALLATION_ID.test(installationId), "The profile's installation.id is missing or invalid");
    return { binding: { repo: profile.repo, ref: profile.ref, digest, installationId }, files };
  } finally {
    await rm(gitDir, { recursive: true, force: true });
  }
}

// Writes the profile's files under `dir`, for profileValidate.
export async function writeProfile(dir, files) {
  for (const [rel, data] of files) {
    const destination = path.join(dir, rel);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data, { mode: 0o644 });
  }
}

// The app's own validator, run locally before anything is built. The
// candidate's startup validation stays authoritative.
/** @param {any} config @param {string} dir @param {{ root: string, log?: (message: string) => void }} options */
export async function validateProfile(config, dir, { root, log = () => {} }) {
  if (!config.profileValidate) return;
  const [command, ...args] = config.profileValidate;
  log(`Validating the profile with ${config.profileValidate.join(" ")}…`);
  await exec(command, [...args, dir], { cwd: root });
}

// The binding's revision form: managed variables and the short label.
export function bindingEnv(binding) {
  return {
    PROFILE_DIR: PROFILE_MOUNT,
    PROFILE_REPO: binding.repo,
    PROFILE_REF: binding.ref,
    GC_PROFILE_DIGEST: binding.digest,
    GC_PROFILE_INSTALLATION: binding.installationId,
  };
}
export const bindingLabel = binding => binding.digest.slice(0, 40);

// A revision's binding, from its own environment and labels. `none`: no
// managed variable and no gc-profile label (a revision released without a
// profile, or before profiles existed); `bound`: all five variables and the
// label, consistent; `partial`: anything else, such as a PROFILE_DIR set by
// hand or the label alone. Only bound and none are ever served by a release
// or a rollback, whatever deploy.json says today.
export function revisionBinding(revision) {
  // A profile label is evidence even when the container details cannot be
  // read. Keep it as a partial binding, never a legacy unreadable revision.
  const labelled = Object.prototype.hasOwnProperty.call(revision.metadata?.labels ?? {}, PROFILE_LABEL);
  const containers = revision?.spec?.containers;
  if (!Array.isArray(containers) || containers.length === 0) {
    return labelled ? { state: "partial", present: [`label ${PROFILE_LABEL}`] } : { state: "unreadable" };
  }
  const env = Object.fromEntries((containers[0].env ?? []).filter(e => typeof e?.name === "string").map(e => [e.name, e.value]));
  const present = PROFILE_ENV.filter(name => Object.prototype.hasOwnProperty.call(env, name));
  if (present.length === 0 && !labelled) return { state: "none", binding: null };
  if (present.length === 0) return { state: "partial", present: [`label ${PROFILE_LABEL}`] };
  const binding = { repo: env.PROFILE_REPO, ref: env.PROFILE_REF, digest: env.GC_PROFILE_DIGEST, installationId: env.GC_PROFILE_INSTALLATION };
  const consistent = present.length === PROFILE_ENV.length && env.PROFILE_DIR === PROFILE_MOUNT &&
    typeof binding.repo === "string" && REPO.test(binding.repo) && SHA1.test(binding.ref ?? "") && SHA256.test(binding.digest ?? "") &&
    INSTALLATION_ID.test(binding.installationId ?? "") && revision.metadata?.labels?.[PROFILE_LABEL] === bindingLabel(binding);
  return consistent ? { state: "bound", binding } : { state: "partial", present };
}

// The binding a service's template carries: what a new revision would inherit
// (--update-env-vars and --labels merge into it).
export const templateBinding = service => revisionBinding({ metadata: service?.spec?.template?.metadata, spec: service?.spec?.template?.spec });

// A bound or partial reading establishes profile context for its whole set.
// The legacy unreadable exception is allowed only when no such evidence exists.
export const hasProfileEvidence = reading => reading.state === "bound" || reading.state === "partial";

export const sameBinding = (a, b) => (a === null || b === null
  ? a === b
  : a.repo === b.repo && a.ref === b.ref && a.digest === b.digest && a.installationId === b.installationId);
export const describeBinding = b => (b ? `${b.installationId} ${b.repo}@${b.ref.slice(0, 12)} (${b.digest.slice(0, 12)})` : "no profile");

// The candidate's own installation receipt at profileHealth, against the
// binding it was released with. `appVersion` must name the revision (core
// reports K_REVISION). Without a profile, the candidate must report none.
// Same candidate origin, IAM headers and redirect refusal as the smoke checks;
// the timeout is the service's longest smoke allowance, in case this request
// is the one that meets a cold instance.
export async function profileCheck(config, access, revision, binding, { fetch: request = fetch }) {
  const { base, headers } = access;
  const url = new URL(config.profileHealth, base);
  requireValue(url.origin === base.origin, "profileHealth must stay on the candidate origin");
  const timeout = Math.max(30000, ...config.smoke.map(c => c.timeoutMs ?? 30000));
  const response = await request(url, { headers, redirect: "error", signal: AbortSignal.timeout(timeout) });
  requireValue(response.status === 200, `Profile check ${config.profileHealth}: expected 200, got ${response.status}`);
  /** @type {any} */
  let body;
  try { body = await response.json(); } catch { requireValue(false, `Profile check ${config.profileHealth}: not JSON`); }
  const reported = body?.installation ?? null;
  if (!binding) {
    requireValue(reported === null, `Profile check: the candidate reports installation ${JSON.stringify(reported)}, but it was released without a profile`);
    return;
  }
  const expected = { appVersion: revision, installationId: binding.installationId, profileRepo: binding.repo, profileRef: binding.ref, profileDigest: binding.digest };
  requireValue(object(reported), `Profile check: the candidate reports no installation receipt; expected ${describeBinding(binding)}`);
  const wrong = Object.keys(expected).filter(k => reported[k] !== expected[k]);
  requireValue(wrong.length === 0, `Profile check: the candidate's receipt differs in ${wrong.map(k => `${k} (${JSON.stringify(reported[k])}, expected ${JSON.stringify(expected[k])})`).join(", ")}`);
}
