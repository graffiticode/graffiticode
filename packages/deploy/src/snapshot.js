import { mkdtemp, realpath, lstat, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { requireValue } from "./config.js";
import { run } from "./process.js";

export function included(file, excludes = []) {
  const parts = file.split("/");
  return !parts.some(p => [".git", ".gc-deploy", ".codex", ".agents", "node_modules"].includes(p) || p.startsWith(".env") || /\.(key|pem)$/.test(p)) &&
    !excludes.some(p => file === p || file.startsWith(`${p.replace(/\/$/, "")}/`));
}

export async function snapshot(root, config, allowDirty = false) {
  const gitRoot = await run("git", ["rev-parse", "--show-toplevel"], { cwd: root });
  requireValue(await realpath(gitRoot) === await realpath(root), "deploy.json must be at the Git workspace root");
  const commit = await run("git", ["rev-parse", "HEAD"], { cwd: root });
  const changes = await run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root });
  requireValue(!changes || allowDirty, "Workspace has uncommitted changes; commit them or pass --allow-dirty");
  const files = [...new Set((await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, raw: true })).split("\0").filter(Boolean))].sort();
  const dir = await mkdtemp(path.join(tmpdir(), "gc-deploy-"));
  const source = path.join(dir, "source");
  await mkdir(source);
  const digest = createHash("sha256");
  const manifest = [];
  try {
    for (const file of files) {
      if (!included(file, config.exclude)) continue;
      requireValue(!path.isAbsolute(file) && !file.split("/").includes(".."), "Unsafe source path");
      const origin = path.join(root, file);
      const stat = await lstat(origin).catch(err => { if (err.code !== "ENOENT") throw err; });
      if (!stat) continue; // tracked deletion in an explicitly allowed dirty workspace
      requireValue(stat.isFile(), `Source must be a regular file (no symlinks/submodules): ${file}`);
      requireValue(await realpath(origin) === path.join(await realpath(root), file), `Source path traverses a symlink: ${file}`);
      const data = await readFile(origin);
      const mode = stat.mode & 0o111 ? 0o755 : 0o644;
      digest.update(JSON.stringify([file, mode, data.length])).update("\0").update(data);
      const destination = path.join(source, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, data, { mode });
      manifest.push(file);
    }
    requireValue(manifest.includes(config.dockerfile), "Dockerfile is missing from the source snapshot");
    // Submit a prebuilt archive so gcloud cannot apply a second implicit ignore policy.
    // Entries are owned by root: Cloud Build keeps archive ownership, and npm runs
    // a package's scripts as its directory's owner, which cannot write $HOME.
    const archive = path.join(dir, "source.tar.gz");
    await run("tar", ["--owner=0", "--group=0", "--numeric-owner", "-czf", archive, "-C", source, "."]);
    return { dir, archive, sourceHash: digest.digest("hex"), commit, dirty: Boolean(changes), changes, files: manifest };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
