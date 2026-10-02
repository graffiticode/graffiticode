// Private execution artifacts: the unsigned output of a successful compile
// through a selected connection, one per invocation. They are separate from
// the shared compile cache (compiles/), which never holds a protected chain.
//
// An artifact is bound to the recipient, the connection's owner, the
// connection, the task chain, the invocation and the registry version, and
// holds no credential or token. A view (see the read path) serves the current
// artifact for its own recipient, task chain and connection, where "current"
// is invocation order, not completion order: the head moves only to a newer
// invocation (compare-and-set on seq), so a slow older run cannot replace a
// newer result.
//
// Once stored, an artifact is immutable (spec ARTIFACT-01): a retry of the same
// invocation is acknowledged only if its content (by canonical digest) and
// every binding field match; anything else is refused with ArtifactConflict,
// so a retry can never replace the artifact a publication already names.
// Differing output needs a new invocation.
//
//   put({ uid, ownerUid, connectionId, taskId, invocationId, seq, registryVersion, content })
//     -> { current, acknowledged }   whether this invocation is now the head,
//        and whether an identical artifact was already stored
//     throws ArtifactConflict when a different one was
//   getCurrent({ uid, taskId, connectionId, registryVersion })
//     -> { status: "ok", artifact } | { status: "missing" } | { status: "incompatible" }
//   getByInvocation(invocationId) -> artifact | null   (the one a publication names)
//
// "missing" and "incompatible" both mean an explicit run is needed; a read must
// never rebuild the artifact by executing the program.

import { createHash } from "node:crypto";
import { canonicalDigest } from "@graffiticode/common/canonical";
import { admin } from "./firebase.js";

// The fields an artifact is bound to. (Plan and compiler revision join them
// with admission, spec W4.)
export const ARTIFACT_BINDING_FIELDS = Object.freeze([
  "uid", "ownerUid", "connectionId", "taskId", "invocationId", "seq", "registryVersion"
]);

export class ArtifactConflict extends Error {
  constructor(invocationId, reason) {
    super(`artifact for invocation ${invocationId} already stored with different ${reason === "content-differs" ? "content" : "bindings"}`);
    this.invocationId = invocationId;
    this.reason = reason;
  }
}

// An identical put is acknowledged; anything else conflicts. The digest is
// computed from the stored content, so artifacts stored before digests were
// recorded compare the same way.
const checkSame = (existing, binding, contentDigest) => {
  if (!ARTIFACT_BINDING_FIELDS.every(f => existing[f] === binding[f])) {
    throw new ArtifactConflict(binding.invocationId, "binding-differs");
  }
  if (canonicalDigest(existing.content) !== contentDigest) {
    throw new ArtifactConflict(binding.invocationId, "content-differs");
  }
};

const headId = ({ uid, taskId, connectionId }) =>
  createHash("sha256").update(JSON.stringify([uid, taskId, connectionId])).digest("hex");

const sameOwner = (artifact, { uid, taskId, connectionId }) =>
  artifact.uid === uid && artifact.taskId === taskId && artifact.connectionId === connectionId;

const resolveCurrent = (artifact, query) => {
  if (!artifact || !sameOwner(artifact, query)) return { status: "missing" };
  if (artifact.registryVersion !== query.registryVersion) return { status: "incompatible" };
  return { status: "ok", artifact };
};

export const buildMemoryArtifactStorer = () => {
  const artifacts = new Map();
  const heads = new Map();
  return {
    async put({ content, ...binding }) {
      const stored = JSON.parse(JSON.stringify(content));
      const contentDigest = canonicalDigest(stored);
      const existing = artifacts.get(binding.invocationId);
      if (existing) checkSame(existing, binding, contentDigest);
      else artifacts.set(binding.invocationId, { ...binding, contentDigest, content: stored });
      const acknowledged = Boolean(existing);
      // @ts-expect-error TS-MIGRATE: checkJs infers a destructured parameter's type from its default; optional fields read as missing
      const key = headId(binding);
      const head = heads.get(key);
      if (head && head.seq > binding.seq) return { current: false, acknowledged };
      heads.set(key, { invocationId: binding.invocationId, seq: binding.seq });
      return { current: true, acknowledged };
    },
    async getCurrent(query) {
      const head = heads.get(headId(query));
      return resolveCurrent(head ? artifacts.get(head.invocationId) : null, query);
    },
    async getByInvocation(invocationId) {
      const artifact = artifacts.get(invocationId);
      return artifact ? JSON.parse(JSON.stringify(artifact)) : null;
    },
  };
};

export const buildArtifactStorer = ({ db = admin.firestore() } = {}) => {
  const artifactRef = invocationId => db.collection("artifacts").doc(invocationId);
  const headRef = binding => db.collection("artifact-heads").doc(headId(binding));
  return {
    async put({ content, ...binding }) {
      const now = new Date().toISOString();
      // Content is stored as JSON text: Firestore cannot hold every shape a
      // compile returns (arrays of arrays, for one).
      const text = JSON.stringify(content);
      const contentDigest = canonicalDigest(JSON.parse(text));
      return db.runTransaction(async tx => {
        const existing = await tx.get(artifactRef(binding.invocationId));
        const head = await tx.get(headRef(binding));
        if (existing.exists) {
          const { content: storedText, ...storedBinding } = existing.data();
          checkSame({ ...storedBinding, content: JSON.parse(storedText) }, binding, contentDigest);
        } else {
          tx.create(artifactRef(binding.invocationId), { ...binding, contentDigest, content: text, createdAt: now });
        }
        const acknowledged = existing.exists;
        if (head.exists && head.data().seq > binding.seq) return { current: false, acknowledged };
        tx.set(headRef(binding), { invocationId: binding.invocationId, seq: binding.seq, updatedAt: now });
        return { current: true, acknowledged };
      });
    },
    async getCurrent(query) {
      const head = await headRef(query).get();
      if (!head.exists) return { status: "missing" };
      const snap = await artifactRef(head.data().invocationId).get();
      if (!snap.exists) return { status: "missing" };
      const { content, ...binding } = snap.data();
      return resolveCurrent({ ...binding, content: JSON.parse(content) }, query);
    },
    async getByInvocation(invocationId) {
      const snap = await artifactRef(invocationId).get();
      if (!snap.exists) return null;
      const { content, ...binding } = snap.data();
      return { ...binding, content: JSON.parse(content) };
    },
  };
};
