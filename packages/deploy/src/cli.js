#!/usr/bin/env node
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, loadConfig } from "./config.js";
import { snapshot } from "./snapshot.js";
import { run } from "./process.js";
import { release, rollback, readReceipt, retireTags, staleTags } from "./release.js";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`gc-deploy [deploy|rollback|retire-tags] [service] [--env production] [--config deploy.json]
  --plan                 Preview locally; no cloud calls or mutations (retire-tags --plan
                         reads the service to list its stale tags, and changes nothing)
  --allow-dirty          Deploy uncommitted workspace contents with a snapshot hash
  --release <id>         For rollback: restore the traffic preceding this release

Requires Node 22+, git, tar, gcloud, and an existing provisioned Cloud Run service.`);
    return;
  }
  const context = await loadConfig(options);
  const { root, config } = context;
  const receiptDir = path.join(root, ".gc-deploy", "releases");
  const save = async receipt => {
    await mkdir(receiptDir, { recursive: true });
    const filename = path.join(receiptDir, `${receipt.id}.json`);
    await writeFile(`${filename}.tmp`, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    await rename(`${filename}.tmp`, filename);
  };
  const cloud = async (args, { json = true, stream = false } = {}) => {
    const scoped = [...args, `--project=${config.project}`, "--quiet"];
    if (["builds", "run"].includes(args[0])) scoped.push(`--region=${config.region}`);
    if (json) scoped.push("--format=json");
    // @ts-expect-error TS-MIGRATE: checkJs infers a destructured parameter's type from its default; optional fields read as missing
    const output = await run("gcloud", scoped, { cwd: root, stream });
    return json ? JSON.parse(output) : output;
  };
  if (options.command === "retire-tags" && options.plan) {
    const service = await cloud(["run", "services", "describe", config.service]);
    console.log(JSON.stringify({ action: "retire-tags", target: `${config.project}/${config.region}/${config.service}`, staleTags: staleTags(service) }, null, 2));
    return;
  }
  if (options.command === "rollback" && options.plan) {
    const receipt = await readReceipt(root, options.release);
    console.log(JSON.stringify({ action: "rollback", target: `${config.project}/${config.region}/${config.service}`, release: receipt.id, restoreTraffic: receipt.previousTraffic }, null, 2));
    return;
  }
  let source;
  let lock;
  const lockPath = path.join(root, ".gc-deploy", `${config.project}-${config.region}-${config.service}.lock`);
  try {
    if (!options.plan) {
      await mkdir(path.dirname(lockPath), { recursive: true });
      lock = await open(lockPath, "wx", 0o600).catch(err => {
        if (err.code === "EEXIST") throw new Error(`A local release is already running (${lockPath}). If interrupted, verify its cloud status before removing this lock.`);
        throw err;
      });
      await lock.writeFile(String(process.pid));
    }
    if (options.command === "retire-tags") {
      const retired = await retireTags(context, { cloud, log: console.log });
      console.log(`Retired ${retired.length} tag(s) on ${config.service}.`);
      return;
    }
    if (options.command === "rollback") {
      const receipt = await readReceipt(root, options.release);
      await save(await rollback(context, receipt, { cloud, log: console.log }));
      console.log(`Restored the traffic preceding ${receipt.id}.`);
      return;
    }
    source = await snapshot(root, config, options.plan || options["allow-dirty"]);
    console.log(JSON.stringify({
      action: "deploy",
      target: `${config.project}/${config.region}/${config.service}`,
      environment: context.environment,
      commit: source.commit,
      dirty: source.dirty,
      changes: source.changes || undefined,
      sourceHash: source.sourceHash,
      files: source.files.length,
      configHash: context.configHash,
      config,
      requiredVariables: context.unresolved
    }, null, 2));
    if (options.plan) return;
    const receipt = await release(context, source, { cloud, log: console.log, save, temp: source.dir });
    console.log(`Released ${receipt.revision}: ${receipt.url}\nReceipt: ${path.join(receiptDir, `${receipt.id}.json`)}\nRollback: npm run rollback -- ${context.service} --env ${context.environment} --release ${receipt.id}`);
  } finally {
    if (source) await rm(source.dir, { recursive: true, force: true });
    if (lock) {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
}
main().catch(error => {
  console.error(`gc-deploy: ${error.message}`);
  process.exitCode = 1;
});
