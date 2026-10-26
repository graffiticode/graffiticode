#!/usr/bin/env node
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, loadConfig, loadEnvironment, requireValue } from "./config.js";
import { planImageTags, applyImageTags } from "./image-tags.js";
import { createGit } from "./git.js";
import { snapshot } from "./snapshot.js";
import { run, streamOutput } from "./process.js";
import { release, rollback, readReceipt, retireTags, staleTags, releaseCheck, approveReleased, promote, evidenceProblems } from "./release.js";
import { createFirestoreRest, createRevisionClient, retainedTags } from "./revisions.js";

// gcloud, scoped to a project (and, for Cloud Build and Cloud Run, its region).
function gcloud({ project, region, root }) {
  const scope = args => {
    const scoped = [...args, `--project=${project}`, "--quiet"];
    if (["builds", "run"].includes(args[0])) scoped.push(`--region=${region}`);
    return scoped;
  };
  const cloud = async (args, { json = true, stream = false } = {}) => {
    const scoped = scope(args);
    if (json) scoped.push("--format=json");
    // @ts-expect-error TS-MIGRATE: checkJs infers a destructured parameter's type from its default; optional fields read as missing
    const output = await run("gcloud", scoped, { cwd: root, stream });
    return json ? JSON.parse(output) : output;
  };
  return { scope, cloud };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`gc-deploy [deploy|rollback|retire-tags|release-check|approve|promote] [service] [--env production] [--config deploy.json]
gc-deploy reconcile-image-tags [--env production] [--plan]
  --plan                 Preview locally; no cloud calls or mutations (retire-tags --plan
                         reads the service to list its stale tags, and reconcile-image-tags
                         --plan reads the project to list its changes; neither changes anything)
  --allow-dirty          Deploy uncommitted workspace contents with a snapshot hash
  --stage                For a release: deploy and check the candidate, then stop with it
                         tagged and no traffic (receipt status staged) until promote
  --release <id>         For rollback: restore the traffic preceding this release; for
                         approve: record this released revision of a pinnable service; for
                         promote: the staged release to promote
  --evidence <file>      For promote: the reviewed inventory evidence (README, "Staging")
  --below-baseline       For rollback: allow a target below the service's milestone baseline
                         (only with protected execution switched off)
  --json                 For release-check: print the result as JSON

release-check (read-only) exits non-zero if the service still has stale tags or
serves a revision below its baseline; protected-execution enable runs it. For a
pinnable service it checks every reachable revision (serving or tagged): each must
be approved in the revisions store, not mid-retirement, support the required
contract version, and meet the baseline. Releases of a pinnable service record
their revision as approved before promotion; approve does it for one released
earlier. Retirement is scripts/revisions.js.

reconcile-image-tags keeps the registry's serving-<revision> tags (which the
cleanup policy keeps) equal to every revision Cloud Run can reach in the project,
whoever deployed it, and warns of tagged revisions kept warm while serving nothing.

Requires Node 22+, git, tar, gcloud, and an existing provisioned Cloud Run service.`);
    return;
  }
  if (options.command === "reconcile-image-tags") {
    const target = await loadEnvironment(options);
    const { cloud } = gcloud(target);
    const plan = await planImageTags({ cloud });
    console.log(`${target.project}: ${plan.reachable} reachable revision(s), ${plan.tags} serving- tag(s); ${plan.add.length} to add, ${plan.remove.length} to remove.`);
    for (const w of plan.warm) console.log(`WARNING: ${w.revision} serves no traffic but is kept warm (revision min ${w.minInstances}) by a traffic tag; retire its tag, or release ${w.service} with minInstances 0.`);
    for (const o of plan.outside) console.log(`  not protected (image outside this project's registry): ${o.revision} ${o.image}`);
    if (options.plan) {
      console.log(JSON.stringify({ action: "reconcile-image-tags", project: target.project, add: plan.add, remove: plan.remove }, null, 2));
      return;
    }
    await applyImageTags(plan, { cloud, log: console.log });
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
  const { scope, cloud } = gcloud({ project: config.project, region: config.region, root });
  const streamLog = buildId => streamOutput("gcloud", scope(["builds", "log", buildId, "--stream"]), { cwd: root });
  const git = createGit(root);
  // The approved-revisions store (capability plan W4), over Firestore's REST
  // API as the operator.
  const firestore = createFirestoreRest({ project: config.project, accessToken: async () => String(await run("gcloud", ["auth", "print-access-token"])).trim() });
  const revisions = config.pinnable ? createRevisionClient(config, firestore) : undefined;
  // Policy's and Broker's own report of the switch (GET /v1/protected-execution),
  // with the operator's identity for Cloud Run IAM. true means on.
  const switchState = async () => {
    requireValue(config.protectedExecution, "deploy.json has no protectedExecution { policyUrl, brokerUrl } to check the switch with");
    const token = String(await cloud(["auth", "print-identity-token"], { json: false })).trim();
    const read = async url => {
      const res = await fetch(`${url}/v1/protected-execution`, { headers: { Authorization: `Bearer ${token}` } });
      /** @type {any} */
      const body = await res.json().catch(() => null);
      requireValue(res.ok && typeof body?.enabled === "boolean", `${url}/v1/protected-execution answered ${res.status}`);
      return body.enabled;
    };
    return { policy: await read(config.protectedExecution.policyUrl), broker: await read(config.protectedExecution.brokerUrl) };
  };
  if (options.command === "release-check") {
    const result = await releaseCheck(context, { cloud, git, revisions });
    if (options.json) console.log(JSON.stringify(result));
    else {
      console.log(`${result.service}: ${result.ok ? "ok" : "NOT READY"}; serving ${result.serving.join(", ")}`);
      if (result.staleTags.length) console.log(`  stale tags: ${result.staleTags.join(", ")}`);
      if (result.belowBaseline.length) console.log(`  below the ${result.baseline.milestone} milestone (${result.baseline.commit.slice(0, 12)}): ${result.belowBaseline.join(", ")}`);
      const labels = { unapproved: "not in the revisions store", retiring: "mid-retirement (scripts/revisions.js retire --resume or --cancel)", retired: "retired but still reachable", unsupportedContract: "without the required contract version" };
      for (const [key, label] of Object.entries(labels)) {
        if (result.revisions?.[key]?.length) console.log(`  reachable and ${label}: ${result.revisions[key].join(", ")}`);
      }
      for (const p of result.contractMinimum ?? []) {
        console.log(`  reachable with ${config.contractMinimum.env} ${p.problem === "missing" ? "unset" : p.problem === "unreadable" ? "unreadable" : `=${p.value}`} (${p.problem}): ${p.revision}`);
      }
      for (const p of result.requires ?? []) console.log(`  requires ${p.service} at ${p.milestone}, but reachable below it: ${p.below.join(", ")}`);
      for (const p of result.network ?? []) console.log(`  reachable without the network controls (${p.problems.join(", ")}): ${p.revision}`);
      for (const p of result.forbiddenEnv ?? []) {
        console.log(`  reachable ${p.problem === "unreadable" ? "with an unreadable environment" : `carrying forbidden ${p.env.join(", ")}`}: ${p.revision}`);
      }
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (options.command === "retire-tags" && options.plan) {
    const service = await cloud(["run", "services", "describe", config.service]);
    const keep = revisions ? retainedTags(service, await revisions.list()) : [];
    console.log(JSON.stringify({ action: "retire-tags", target: `${config.project}/${config.region}/${config.service}`, staleTags: staleTags(service, keep), retained: keep }, null, 2));
    return;
  }
  if (options.command === "approve" && options.plan) {
    const receipt = await readReceipt(root, options.release);
    console.log(JSON.stringify({ action: "approve", target: `${config.project}/${config.region}/${config.service}`, release: receipt.id, revision: receipt.revision, pinnable: config.pinnable ?? null }, null, 2));
    return;
  }
  if (options.command === "promote" && options.plan) {
    const receipt = await readReceipt(root, options.release);
    const evidence = JSON.parse(await readFile(path.resolve(options.evidence), "utf8"));
    console.log(JSON.stringify({ action: "promote", target: `${config.project}/${config.region}/${config.service}`, release: receipt.id, revision: receipt.revision, status: receipt.status, networkHash: receipt.networkHash ?? null, evidenceProblems: evidenceProblems(evidence, receipt, config) }, null, 2));
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
      const retired = await retireTags(context, { cloud, log: console.log, revisions });
      console.log(retired.length
        ? `Retired ${retired.length} tag(s) on ${config.service}; removal verified at ${new Date().toISOString()}.`
        : `Retired 0 tag(s) on ${config.service}.`);
      return;
    }
    if (options.command === "approve") {
      const receipt = await approveReleased(context, await readReceipt(root, options.release), { cloud, revisions });
      await save(receipt);
      console.log(`Approved ${receipt.revision} (${receipt.approval.tagUrl}).`);
      return;
    }
    if (options.command === "promote") {
      const evidence = JSON.parse(await readFile(path.resolve(options.evidence), "utf8"));
      const receipt = await promote(context, await readReceipt(root, options.release), evidence, { cloud, log: console.log, save, git, revisions });
      console.log(`Released ${receipt.revision}: ${receipt.url}\nReceipt: ${path.join(receiptDir, `${receipt.id}.json`)}\nRollback: npm run rollback -- ${context.service} --env ${context.environment} --release ${receipt.id}`);
      if (receipt.tagRetirementError) process.exitCode = 1;
      return;
    }
    if (options.command === "rollback") {
      const receipt = await readReceipt(root, options.release);
      await save(await rollback(context, receipt, { cloud, log: console.log, git, switchState, allowBelowBaseline: Boolean(options["below-baseline"]) }));
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
    const receipt = await release(context, source, { cloud, streamLog, log: console.log, save, temp: source.dir, revisions, git, stage: Boolean(options.stage) });
    if (receipt.status === "staged") {
      console.log(`Staged ${receipt.revision} with no traffic: ${receipt.url}\nNetwork hash: ${receipt.networkHash ?? "(no network)"}\nReceipt: ${path.join(receiptDir, `${receipt.id}.json`)}\nPromote: npm run deploy -- promote ${context.service} --env ${context.environment} --release ${receipt.id} --evidence <file>`);
      return;
    }
    console.log(`Released ${receipt.revision}: ${receipt.url}\nReceipt: ${path.join(receiptDir, `${receipt.id}.json`)}\nRollback: npm run rollback -- ${context.service} --env ${context.environment} --release ${receipt.id}`);
    // Released, but not ready for protected execution: make that a failed run.
    if (receipt.tagRetirementError) process.exitCode = 1;
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
