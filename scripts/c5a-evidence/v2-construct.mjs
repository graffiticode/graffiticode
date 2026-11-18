// Plan construction at one Policy build, over a recorded v2 admission's own
// inputs (extract-inputs.mjs): that build's real createPolicy, its memory
// stores, allocateInvocation then admit, as the gateway, for the recorded
// user, binding (taskId, connectionId, inputDigest), task ids, stage
// manifests (with their registry versions) and the pinned revisions' recorded
// approval records. The memory invocation store makes a random invocation id;
// a wrapper maps it to the recorded one in both directions, so construction
// sees the recorded invocation id. Prints the constructed plan and digest.
//   node construct.mjs <built repo root> <inputs.json>
import { readFileSync } from "node:fs";
import { generateKeyPair, exportJWK } from "jose";

const [root, inputsFile] = process.argv.slice(2);
const P = await import(`${root}/packages/policy/dist/index.js`);
const { REGISTRY_VERSION } = await import(`${root}/packages/common/dist/protected-registry.js`);
const { planDigest } = await import(`${root}/packages/common/dist/contract.js`);
const inputs = JSON.parse(readFileSync(inputsFile, "utf8"));
const GATEWAY = { role: "gateway" };
const INV = /^inv-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const mapped = (store, recorded) => {
  let actual = null;
  const swap = (v, from, to) => {
    if (typeof v === "string") return from && v === from ? to : v;
    if (Array.isArray(v)) return v.map(x => swap(x, from, to));
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x, from, to)]));
    return v;
  };
  const learn = v => {
    if (typeof v === "string" && INV.test(v) && v !== recorded) actual ??= v;
    else if (Array.isArray(v)) v.forEach(learn);
    else if (v && typeof v === "object") Object.values(v).forEach(learn);
  };
  return new Proxy(store, {
    get(target, prop) {
      const f = target[prop];
      if (typeof f !== "function") return f;
      return (...args) => {
        const r = f.apply(target, swap(args, recorded, actual));
        const back = x => { learn(x); return swap(x, actual, recorded); };
        return r && typeof r.then === "function" ? r.then(back) : back(r);
      };
    },
  });
};

const results = [];
for (const rec of inputs.plans) {
  const { planDoc, invocation, approvals, connection } = rec;
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await P.createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  const leases = new Map();
  let clock = Date.parse(planDoc.createdAt);
  const store = P.createMemoryInvocationStore({ leases });
  const invocations = mapped(store, planDoc.invocationId);
  const policy = P.createPolicy({
    signer, jwks,
    connections: P.createMemoryConnectionStore([{ connectionId: connection.connectionId, ownerUid: connection.ownerUid, backend: connection.backend, status: connection.status, ...(connection.ownerPermissions ? { ownerPermissions: connection.ownerPermissions } : {}) }]),
    invocations,
    publications: P.createMemoryPublicationStore(),
    audit: async () => {},
    protectedSwitch: P.createProtectedSwitch({ readFlag: async () => ({ enabled: true }) }),
    approvals: P.createMemoryApprovals(new Map(approvals.map(a => [`${a.lang}/${a.revision}`, a]))),
    fence: P.createMemoryLeaseFence({ leases, now: () => clock }),
    now: () => clock,
  });
  const user = { uid: invocation.uid };
  const allocated = await policy.allocateInvocation({ caller: GATEWAY, user, connectionId: invocation.connectionId, taskId: invocation.taskId, inputDigest: invocation.inputDigest, idempotencyKey: "c5a-gate:v2-digest", admission: true });
  let outcome;
  try {
    const admitted = await policy.admit({ caller: GATEWAY, user, invocationToken: allocated.invocationToken, taskIds: planDoc.plan.taskIds, stages: planDoc.plan.stages });
    const stored = await invocations.getPlan(admitted.planDigest);
    outcome = { admitted: true, planDigest: admitted.planDigest, plan: stored ?? null, recomputed: stored ? planDigest(stored) : null };
  } catch (e) {
    outcome = { admitted: false, refusal: e?.reason ?? String(e?.message ?? e) };
  }
  results.push({ recordedDigest: rec.digest, invocationId: allocated.invocationId, registryVersion: REGISTRY_VERSION, ...outcome });
}
console.log(JSON.stringify(results));
