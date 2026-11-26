// The harness's two stores: the api's (`graffiticode`) and the console's
// (`graffiticode-app`), modelled as two Firestore EMULATOR projects so that,
// as in production, no transaction can span both
// (docs/c4-continuation-race-review.md §1).
//
// Safety, before anything connects:
// - FIRESTORE_EMULATOR_HOST must be set and name a loopback host. Without it
//   the Firestore client would reach real Google Cloud with ambient
//   credentials, so the harness refuses to load at all rather than skip.
// - Both project ids start with `demo-`, which the Firebase emulator treats as
//   projects that can never touch production resources.
// - Nothing is ever deleted. Each test writes under a fresh random namespace
//   prefix, so no clearing call exists in this harness.

import { Firestore } from "@google-cloud/firestore";
import { randomUUID } from "node:crypto";

export const API_PROJECT = "demo-c4-harness-api";
export const CONSOLE_PROJECT = "demo-c4-harness-console";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function assertEmulator(env = process.env) {
  const host = env.FIRESTORE_EMULATOR_HOST;
  if (!host) {
    throw new Error(
      "continuation harness: FIRESTORE_EMULATOR_HOST is not set. Run it inside " +
        "`firebase emulators:exec --only firestore` (npm run test:ci:emulated); it never runs against real Firestore.",
    );
  }
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  if (!LOOPBACK.has(name)) {
    throw new Error(`continuation harness: FIRESTORE_EMULATOR_HOST=${host} is not a loopback emulator; refusing to run.`);
  }
  for (const project of [API_PROJECT, CONSOLE_PROJECT]) {
    if (!project.startsWith("demo-")) throw new Error(`continuation harness: ${project} is not a demo- project id.`);
  }
  return host;
}

assertEmulator();

const clients = {};
const client = projectId => (clients[projectId] ??= new Firestore({ projectId }));

// One store: a Firestore client plus a namespace that prefixes every
// top-level collection, so concurrent tests never see each other's documents.
class Store {
  constructor(projectId, ns) {
    this.db = client(projectId);
    this.ns = ns;
    this.projectId = projectId;
  }
  col(name) {
    return this.db.collection(`${this.ns}__${name}`);
  }
  doc(name, id) {
    return this.col(name).doc(id);
  }
  run(fn) {
    return this.db.runTransaction(fn);
  }
}

export function makeStores(label = "t") {
  const ns = `${label}-${randomUUID().slice(0, 8)}`;
  return { api: new Store(API_PROJECT, ns), console: new Store(CONSOLE_PROJECT, ns), ns };
}

export async function closeStores() {
  await Promise.all(Object.values(clients).map(c => c.terminate()));
}
