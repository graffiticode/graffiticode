import test from "node:test";
import assert from "node:assert/strict";
import { planImageTags, applyImageTags, registryImage, releaseTime, GRACE_MS } from "../src/image-tags.js";
import { parseArgs } from "../src/config.js";

const NOW = Date.parse("2026-10-27T00:00:00Z");
const id = ms => `r${ms.toString(36)}-abcdef`;
const sha = n => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const REPO = "us-central1-docker.pkg.dev/proj/services";

// A project: Cloud Run services and revisions, and the registry's tags.
function project({ services, revisions, tags }) {
  const calls = [];
  const cloud = async (args, opts = {}) => {
    calls.push(args);
    if (args[0] === "run" && args[1] === "services" && args[2] === "list") return services;
    if (args[0] === "run" && args[1] === "revisions" && args[2] === "describe") return revisions[args[3]];
    if (args[0] === "artifacts" && args[1] === "repositories") {
      return [
        { name: "projects/proj/locations/us-central1/repositories/services", format: "DOCKER" },
        { name: "projects/proj/locations/us/repositories/gcr.io", format: "DOCKER" },
        { name: "projects/proj/locations/us-central1/repositories/npm", format: "NPM" },
      ];
    }
    if (args[0] === "artifacts" && args[2] === "tags" && args[3] === "list") {
      return tags.filter(t => t.image.startsWith(`${args[4]}/`)).map(t => ({
        image: t.image,
        tag: `projects/proj/locations/x/repositories/x/packages/x/tags/${t.tag}`,
        version: `projects/proj/locations/x/repositories/x/packages/x/versions/${t.digest}`,
      }));
    }
    if (args[0] === "artifacts" && args[2] === "tags") return opts.json === false ? "" : {};
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return { cloud, calls };
}
const revision = (image, digest, min) => ({
  status: { imageDigest: `${image}@${digest}` },
  metadata: { annotations: min ? { "autoscaling.knative.dev/minScale": String(min) } : {} },
});

test("image names and release times", () => {
  assert.equal(registryImage("gcr.io/proj/l0001"), "us-docker.pkg.dev/proj/gcr.io/l0001");
  assert.equal(registryImage("eu.gcr.io/proj/x/y"), "europe-docker.pkg.dev/proj/eu.gcr.io/x/y");
  assert.equal(registryImage(`${REPO}/api`), `${REPO}/api`);
  assert.equal(releaseTime(`api-${id(NOW)}`), NOW);
  assert.equal(releaseTime("l0001-00023-nek"), null);
  assert.throws(() => parseArgs(["reconcile-image-tags", "api"]), /takes no service/);
  assert.equal(parseArgs(["reconcile-image-tags", "--plan"]).command, "reconcile-image-tags");
});

test("tags follow reachable revisions; images still run keep theirs; in-flight releases keep theirs", async () => {
  const old = NOW - 10 * GRACE_MS;
  const serving = `api-${id(old)}`; // serves; already tagged
  const kept = `api-${id(old + 1)}`; // 0% but kept by a traffic tag, with a revision min
  const config = "console-00698-sp7"; // out-of-band update of the console release's image
  const legacy = "l0001-00023-nek"; // gcr.io image, deployed outside gc-deploy, untagged
  const p = project({
    services: [
      { metadata: { name: "api" }, status: { traffic: [{ revisionName: serving, percent: 100, tag: "a" }, { revisionName: kept, tag: "b" }, { revisionName: `api-${id(old + 2)}`, percent: 0 }] } },
      { metadata: { name: "console" }, status: { traffic: [{ revisionName: config, percent: 100 }] } },
      { metadata: { name: "l0001" }, status: { traffic: [{ revisionName: legacy, percent: 100 }] } },
      { metadata: { name: "www" }, status: { traffic: [{ revisionName: "www-00071-h8t", percent: 100 }] } },
    ],
    revisions: {
      [serving]: revision(`${REPO}/api`, sha(1)),
      [kept]: revision(`${REPO}/api`, sha(2), 1),
      [config]: revision(`${REPO}/console`, sha(3), 1),
      [legacy]: revision("gcr.io/proj/l0001", sha(4)),
      "www-00071-h8t": revision("gcr.io/other-project/www", sha(5)),
    },
    tags: [
      { image: `${REPO}/api`, tag: `serving-${serving}`, digest: sha(1) },
      { image: `${REPO}/api`, tag: `serving-${kept}`, digest: sha(2) },
      // The console release's revision lost its traffic tag; its image still serves.
      { image: `${REPO}/console`, tag: `serving-console-${id(old)}`, digest: sha(3) },
      // A release retired long ago: removed.
      { image: `${REPO}/api`, tag: `serving-api-${id(old - 5)}`, digest: sha(6) },
      // Hand-tagged, revision gone, no release id to date it: removed.
      { image: "us-docker.pkg.dev/proj/gcr.io/l0002", tag: "serving-l0002-00104-abc", digest: sha(7) },
      // A release in flight: tagged, revision not created yet.
      { image: `${REPO}/api`, tag: `serving-api-${id(NOW - 60000)}`, digest: sha(8) },
      // Not a serving- tag: left alone.
      { image: `${REPO}/api`, tag: id(old - 5), digest: sha(6) },
    ],
  });
  const plan = await planImageTags({ cloud: p.cloud, now: NOW });
  assert.equal(plan.reachable, 5);
  assert.deepEqual(plan.remove.map(r => r.tag).sort(), [`serving-api-${id(old - 5)}`, "serving-l0002-00104-abc"]);
  assert.deepEqual(plan.add, [{ image: "us-docker.pkg.dev/proj/gcr.io/l0001", digest: sha(4), tag: `serving-${legacy}`, revision: legacy }]);
  assert.deepEqual(plan.warm, [{ service: "api", revision: kept, minInstances: 1 }]);
  assert.deepEqual(plan.outside, [{ revision: "www-00071-h8t", image: "us-docker.pkg.dev/other-project/gcr.io/www" }]);

  await applyImageTags(plan, { cloud: p.cloud });
  const writes = p.calls.filter(c => c[0] === "artifacts" && (c[3] === "add" || c[3] === "delete"));
  // Protection before removal.
  assert.deepEqual(writes.map(c => c[3]), ["add", "delete", "delete"]);
  assert.deepEqual(writes[0], ["artifacts", "docker", "tags", "add", `us-docker.pkg.dev/proj/gcr.io/l0001@${sha(4)}`, `us-docker.pkg.dev/proj/gcr.io/l0001:serving-${legacy}`]);
});
