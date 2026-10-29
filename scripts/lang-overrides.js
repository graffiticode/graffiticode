#!/usr/bin/env node
// P5 (docs/graffiticode-interpreter-plan.md): point a tester at a language's
// Rust service before its switch, through the API's per-user language
// override, and take them off it again.
//
//   node scripts/lang-overrides.js status [--uid <uid>]
//   node scripts/lang-overrides.js set   --uid <uid> --lang 0184 [--url <https base URL>] [--any-url] [--plan]
//   node scripts/lang-overrides.js clear --uid <uid> [--lang 0184] [--plan]
//
// `set` binds the language to its Rust service, lNNNNr. Without --url it
// resolves the service's URL with gcloud; a URL that isn't lNNNNr's Cloud Run
// service (or a revision tag on it) is refused unless --any-url is passed.
// `clear` removes one binding, or every binding with no --lang, deleting the
// document when none are left. --plan prints the write without making it.
// The deploy-check account (VERIFY_UID) is refused: its routing must stay the
// default. The API applies a change within 10 s; compiles through a connection
// are refused under an override, so a soak covers paths without one.
//
// Writes the API's Firestore (the default database) in --project (default
// graffiticode), with application-default credentials.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { VERIFY_UID } from "../verify/auth.js";
import { COLLECTION, parse, readBindings, urlProblem, withBinding, withoutBinding, writeBindings } from "./lib/lang-overrides.js";

const resolveServiceUrl = (key, project) => {
  const service = `${key.toLowerCase()}r`;
  const deployConfig = JSON.parse(readFileSync(new URL("../deploy.json", import.meta.url), "utf8"));
  const region = deployConfig.environments?.production?.region ?? "us-central1";
  return execFileSync("gcloud", ["run", "services", "describe", service, `--project=${project}`, `--region=${region}`, "--format=value(status.url)"], { encoding: "utf8" }).trim();
};

const main = async () => {
  const opts = parse(process.argv.slice(2), { refused: { [VERIFY_UID]: "deploy-check account (VERIFY_UID)" } });
  const db = getFirestore(initializeApp({ credential: applicationDefault(), projectId: opts.project }));
  if (opts.command === "status") {
    const docs = opts.uid
      ? [{ id: opts.uid, bindings: await readBindings(db, opts.uid) }]
      : (await db.collection(COLLECTION).get()).docs.map(d => ({ id: d.id, bindings: d.data()?.bindings ?? {} }));
    console.log(JSON.stringify(docs.filter(d => Object.keys(d.bindings).length), null, 2));
    return;
  }
  const before = await readBindings(db, opts.uid);
  let after;
  if (opts.command === "set") {
    const url = opts.url ?? resolveServiceUrl(opts.lang, opts.project);
    const problem = urlProblem(opts.lang, url, { anyUrl: opts.anyUrl });
    if (problem) throw new Error(problem);
    after = withBinding(before, opts.lang, url.replace(/\/$/, ""));
  } else {
    after = withoutBinding(before, opts.lang);
  }
  const wrote = await writeBindings(db, opts.uid, after, { plan: opts.plan });
  console.log(JSON.stringify({ plan: opts.plan, before, ...wrote }, null, 2));
};

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
