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
// newer result. A retry of the same invocation rewrites its own artifact.
//
//   put({ uid, ownerUid, connectionId, taskId, invocationId, seq, registryVersion, content })
//     -> { current }   whether this invocation is now the head
//   getCurrent({ uid, taskId, connectionId, registryVersion })
//     -> { status: "ok", artifact } | { status: "missing" } | { status: "incompatible" }
//   getByInvocation(invocationId) -> artifact | null   (the one a publication names)
//
// "missing" and "incompatible" both mean an explicit run is needed; a read must
// never rebuild the artifact by executing the program.

import { createHash } from "node:crypto";
import { admin } from "./firebase.js";

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
      artifacts.set(binding.invocationId, { ...binding, content: JSON.parse(JSON.stringify(content)) });
      const key = headId(binding);
      const head = heads.get(key);
      if (head && head.seq > binding.seq) return { current: false };
      heads.set(key, { invocationId: binding.invocationId, seq: binding.seq });
      return { current: true };
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
      return db.runTransaction(async tx => {
        const head = await tx.get(headRef(binding));
        // Content is stored as JSON text: Firestore cannot hold every shape a
        // compile returns (arrays of arrays, for one).
        tx.set(artifactRef(binding.invocationId), { ...binding, content: JSON.stringify(content), createdAt: now });
        if (head.exists && head.data().seq > binding.seq) return { current: false };
        tx.set(headRef(binding), { invocationId: binding.invocationId, seq: binding.seq, updatedAt: now });
        return { current: true };
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
