// Registry tags that keep serving images from the Artifact Registry cleanup
// policy, reconciled with what Cloud Run can reach, across a project.
//
// Each release tags its image `serving-<revision>` before deploying it
// (release.js), and the cleanup policy keeps anything tagged `serving-`. Nothing
// in a release removes those tags, so on its own every release image would be
// kept forever; and an image deployed outside gc-deploy is never tagged at all.
// This keeps the tags equal to the reachable revisions (serving, or kept by a
// traffic tag), in every service of the project, whoever deployed them:
//   add     a reachable revision whose image carries no serving- tag
//   remove  a serving- tag whose revision is no longer reachable and whose
//           image no reachable revision runs
// A tag whose revision doesn't exist yet may belong to a release in flight
// (the tag is added before the revision); it is kept for GRACE_MS, dated by the
// release id in the revision name. A tag with no datable release id and no
// revision is removed.
//
// It also reports `warm`: revisions reachable only through a traffic tag that
// carry a revision-level minimum, so each holds an always-on instance while
// serving nothing (auth's 15 retained tags held 12 instances until 2026-10-26).

export const SERVING_PREFIX = "serving-";
export const GRACE_MS = 2 * 24 * 60 * 60 * 1000;

// gcr.io-style references are served from the gcr.io repositories in Artifact
// Registry; Cloud Run reports them by their old names.
const GCR_HOSTS = { "gcr.io": "us", "us.gcr.io": "us", "eu.gcr.io": "europe", "asia.gcr.io": "asia" };
export function registryImage(image) {
  const [host, project, ...rest] = image.split("/");
  const location = GCR_HOSTS[host];
  return location ? `${location}-docker.pkg.dev/${project}/${host}/${rest.join("/")}` : image;
}

// When a gc-deploy release was made, from its id (`r<base36 ms>-<hex>`) at the
// end of the revision name; null when the name carries none.
export function releaseTime(revision) {
  const match = /-r([0-9a-z]+)-[0-9a-f]{6}$/.exec(revision);
  if (!match) return null;
  const ms = parseInt(match[1], 36);
  return Number.isFinite(ms) ? ms : null;
}

const basename = resource => resource.split("/").pop();

/**
 * @param {{ cloud: (args: string[], opts?: { json?: boolean }) => Promise<any>, now?: number }} deps
 */
export async function planImageTags({ cloud, now = Date.now() }) {
  // Every reachable revision, with how it is reached.
  const reachable = new Map();
  for (const service of await cloud(["run", "services", "list"])) {
    for (const entry of service.status?.traffic || []) {
      if (!entry.revisionName || !(entry.percent > 0 || entry.tag)) continue;
      const known = reachable.get(entry.revisionName) ?? { service: service.metadata.name, serving: false };
      known.serving ||= entry.percent > 0;
      reachable.set(entry.revisionName, known);
    }
  }
  const warm = [];
  const images = new Map();
  for (const [name, known] of reachable) {
    const revision = await cloud(["run", "revisions", "describe", name]);
    const ref = revision.status?.imageDigest ?? "";
    const at = ref.indexOf("@sha256:");
    if (at > 0) images.set(name, { image: registryImage(ref.slice(0, at)), digest: ref.slice(at + 1) });
    const min = Number(revision.metadata?.annotations?.["autoscaling.knative.dev/minScale"] ?? 0);
    if (!known.serving && min > 0) warm.push({ service: known.service, revision: name, minInstances: min });
  }

  // Every serving- tag in the project's Docker repositories.
  const repositories = (await cloud(["artifacts", "repositories", "list"])).filter(r => r.format === "DOCKER");
  const hosts = new Set();
  const tags = [];
  for (const repo of repositories) {
    const [, project, , location, , id] = repo.name.split("/");
    const host = `${location}-docker.pkg.dev/${project}/${id}`;
    hosts.add(host);
    for (const t of await cloud(["artifacts", "docker", "tags", "list", host])) {
      const tag = basename(t.tag);
      if (tag.startsWith(SERVING_PREFIX)) tags.push({ image: t.image, tag, digest: basename(t.version) });
    }
  }

  // A tag protects an image, not a name: one whose revision is gone still
  // stays while a reachable revision runs that image (an out-of-band update
  // makes a new revision of the release's image, and the release's revision
  // then loses its traffic tag).
  const needed = new Set([...images.values()].map(i => `${i.image}@${i.digest}`));
  const remove = [];
  for (const t of tags) {
    const revision = t.tag.slice(SERVING_PREFIX.length);
    if (reachable.has(revision) || needed.has(`${t.image}@${t.digest}`)) continue;
    const made = releaseTime(revision);
    if (made !== null && now - made < GRACE_MS) continue;
    remove.push({ ...t, revision });
  }
  const tagged = new Set(tags.map(t => `${t.image}@${t.digest}`));
  const add = [];
  const outside = [];
  for (const [revision, { image, digest }] of images) {
    if (tagged.has(`${image}@${digest}`)) continue;
    if (![...hosts].some(host => image.startsWith(`${host}/`))) {
      outside.push({ revision, image });
      continue;
    }
    add.push({ image, digest, tag: `${SERVING_PREFIX}${revision}`, revision });
  }
  return { reachable: reachable.size, tags: tags.length, add, remove, warm, outside };
}

// Applies a plan: protection first, so an image is never left untagged between
// the two steps.
/**
 * @param {{ add: any[], remove: any[] }} plan
 * @param {{ cloud: (args: string[], opts?: { json?: boolean }) => Promise<any>, log?: (message: string) => void }} deps
 */
export async function applyImageTags(plan, { cloud, log = () => {} }) {
  for (const a of plan.add) {
    log(`Tagging ${a.image}@${a.digest} ${a.tag}`);
    await cloud(["artifacts", "docker", "tags", "add", `${a.image}@${a.digest}`, `${a.image}:${a.tag}`], { json: false });
  }
  for (const r of plan.remove) {
    log(`Removing ${r.image}:${r.tag} (revision ${r.revision} is not reachable)`);
    await cloud(["artifacts", "docker", "tags", "delete", `${r.image}:${r.tag}`], { json: false });
  }
}
