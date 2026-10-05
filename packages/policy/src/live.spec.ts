// Every refusal liveRefusal can return, through every entry point that calls
// it: mint (from a session) and authorize-execution (from an execution token).
// Both must give the same answer for the same authority and live state, so
// the two can never drift. The one difference is the provenance check's
// name: a session whose claims don't form a provenance is `bad-session`, an
// execution token's `bad-provenance`. Each row hand-signs the authority's claims, so it tests
// exactly the live state it names and nothing a snapshot would have filtered.
import { generateKeyPair, exportJWK } from "jose";
import { REGISTRY_VERSION, operationSteps } from "@graffiticode/common/protected-registry";
import {
  createPolicy,
  PolicyDenied,
  createLocalSigner,
  issueToken,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createMemoryPublicationStore,
  createMemoryGrantStore,
  grantIdFor,
  createAudit,
  createPseudonymizer,
  createProtectedSwitch,
  verifyToken,
  provenanceRefusal,
  SYSTEM_PREVIEW_SUBJECT
} from "./index.js";

const OWNER = "0xowneruid";
const OTHER = "0xotheruid";
const STRANGER = "0xstrangeruid";
const SYSTEM_OWNER = "0xsystemowner";
const L0176 = { role: "compiler", lang: "0176" };
const BROKER = { role: "broker" };
const ARGD = "a".repeat(64);
const OPS = { init: "learnosity.sign-items-preview", "save-to-itembank": "learnosity.write-items", author: "learnosity.sign-author" };

// Every reason liveRefusal returns. A new one must be added here and given a row.
const REASONS = [
  "bad-session", "not-system-preview", "not-system-connection", "not-view-safe",
  "publication-not-found", "publication-mismatch", "publish-not-granted",
  "connection-not-found", "system-connection", "connection-disabled", "owner-changed",
  "not-owner", "backend-changed", "fn-not-enabled", "not-granted",
];

let signer;
let jwks;
let policy;
let records;
let connections;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  const grant = (recipientUid, fns, expiresAt = null) => ({
    grantId: grantIdFor({ connectionId: "conn-1", recipientUid }),
    connectionId: "conn-1",
    ownerUid: OWNER,
    recipientUid,
    permissions: fns.map(fn => ({ lang: "0176", fn })),
    expiresAt,
  });
  const publications = createMemoryPublicationStore();
  await publications.create({ publicationId: "pub-1", publisherUid: OWNER, ownerUid: OWNER, connectionId: "conn-1", lang: "0176" });
  // A grantee can't publish; this record stands for one that claims to.
  await publications.create({ publicationId: "pub-2", publisherUid: OTHER, ownerUid: OWNER, connectionId: "conn-1", lang: "0176" });
  records = [];
  connections = createMemoryConnectionStore([
    { connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" },
    { connectionId: "conn-off", ownerUid: OWNER, backend: "learnosity", status: "disabled" },
    { connectionId: "conn-x", ownerUid: OWNER, backend: "other", status: "active" },
    { connectionId: "conn-sys", ownerUid: SYSTEM_OWNER, backend: "learnosity", status: "active" },
  ]);
  policy = createPolicy({
    protectedSwitch: createProtectedSwitch({ readFlag: async () => ({ enabled: true }) }),
    signer,
    jwks,
    connections,
    grants: createMemoryGrantStore([
      grant(OTHER, ["init"]),
      grant("0xexpireduid", ["init"], "2000-01-01T00:00:00.000Z"),
    ]),
    publications,
    invocations: createMemoryInvocationStore(),
    systemConnections: { learnosity: "conn-sys" },
    audit: createAudit({ sink: r => records.push(r), pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) }),
  });
});

// The authority's claims: the owner's own session on conn-1 unless a row
// says otherwise.
const authority = over => ({
  sub: OWNER,
  own: OWNER,
  conn: "conn-1",
  backend: "learnosity",
  lang: "0176",
  inv: "inv-1",
  stg: "s0",
  rv: REGISTRY_VERSION,
  ...over,
});
const SYSTEM = { sub: SYSTEM_PREVIEW_SUBJECT, own: SYSTEM_OWNER, conn: "conn-sys", sys: true };

// The execution token mint would issue for these session claims: `sys`/`pub`
// become `prv` (and `pub`). A `sys` that isn't `true` has no execution
// counterpart, so that token's `prv` names no provenance. (A token with no
// `prv` at all can't be issued or verified; authorize.spec.ts covers it.)
const toExecution = (claims, fn) => {
  const { sys, pub, inv, stg, ...rest } = claims;
  const prv = sys === true ? "system" : sys !== undefined ? "unknown" : pub ? "publication" : "user";
  return {
    ...rest,
    prv,
    ...(pub !== undefined ? { pub } : {}),
    fn,
    op: OPS[fn],
    sid: "sid-1",
    opid: `${inv}/${stg}/n1.0`,
    argd: ARGD,
  };
};

// Each entry point takes (claims, fn) and resolves to "allowed" or the reason
// it refused with; `reason` maps a row's expected reason to this entry's name
// for it.
const refusedWith = async promise => {
  try {
    await promise;
    return "allowed";
  } catch (e) {
    if (e instanceof PolicyDenied) return e.reason;
    throw e;
  }
};
const ENTRY_POINTS = {
  mint: async (claims, fn) => {
    const sessionToken = await issueToken(signer, "session", { ...claims, fns: [fn] });
    try {
      await policy.mint({ caller: L0176, sessionToken, fn, op: OPS[fn], occurrenceId: "n1.0", argsDigest: ARGD });
      return "allowed";
    } catch (e) {
      if (e instanceof PolicyDenied) return e.reason;
      throw e;
    }
  },
  // The operation's first registered step, as Broker would ask before it.
  "authorize-execution": async (claims, fn) => {
    const executionToken = await issueToken(signer, "execution", toExecution(claims, fn));
    const [first] = operationSteps(OPS[fn]);
    return refusedWith(policy.authorizeExecution({ caller: BROKER, executionToken, op: OPS[fn], argsDigest: ARGD, step: first.id, purpose: first.purpose, after: null }));
  },
};
const REASON_NAMES = { "authorize-execution": { "bad-session": "bad-provenance" } };
const reasonFor = (entry, reason) => REASON_NAMES[entry]?.[reason] ?? reason;

// A row may change live state after the authority was issued.
const change = (connectionId, fields) => async () => connections.put({ ...(await connections.get(connectionId)), ...fields });

const ROWS: Array<[string, Record<string, unknown>, string, string, (() => Promise<void>)?]> = [
  // [case, authority claims, fn, expected, state change]
  ["the owner", {}, "init", "allowed"],
  ["a grantee, within the grant", { sub: OTHER }, "init", "allowed"],
  ["a live publication", { pub: "pub-1" }, "init", "allowed"],
  ["a system preview", SYSTEM, "init", "allowed"],

  ["system: a subject other than the system's", { ...SYSTEM, sub: OWNER }, "init", "bad-session"],
  ["system: also claiming a publication", { ...SYSTEM, pub: "pub-1" }, "init", "bad-session"],
  ["system: a function outside system previews", SYSTEM, "save-to-itembank", "not-system-preview"],
  ["system: a connection no longer the system's", { ...SYSTEM, conn: "conn-1" }, "init", "not-system-connection"],
  ["system: its connection deleted", SYSTEM, "init", "connection-not-found", () => connections.delete("conn-sys")],
  ["system: its connection disabled", SYSTEM, "init", "connection-disabled", change("conn-sys", { status: "disabled" })],
  ["system: its connection re-owned", SYSTEM, "init", "owner-changed", change("conn-sys", { ownerUid: OTHER })],
  ["system: its connection's backend changed", SYSTEM, "init", "backend-changed", change("conn-sys", { backend: "other" })],
  ["user: the system subject", { sub: SYSTEM_PREVIEW_SUBJECT }, "init", "bad-session"],
  ["user: any `sys` claim", { sys: false }, "init", "bad-session"],

  ["publication: a function that isn't view-safe", { pub: "pub-1" }, "save-to-itembank", "not-view-safe"],
  ["publication: withdrawn", { pub: "pub-gone" }, "init", "publication-not-found"],
  ["publication: on another connection", { pub: "pub-1", conn: "conn-x" }, "init", "publication-mismatch"],
  ["publication: by a grantee", { pub: "pub-2", sub: OTHER }, "init", "publish-not-granted"],
  ["publication: its connection disabled", { pub: "pub-1" }, "init", "connection-disabled", change("conn-1", { status: "disabled" })],

  ["connection deleted", { conn: "conn-gone" }, "init", "connection-not-found"],
  ["the system connection, as a user", { conn: "conn-sys", own: SYSTEM_OWNER }, "init", "system-connection"],
  ["connection disabled", { conn: "conn-off" }, "init", "connection-disabled"],
  ["connection disabled after issue", {}, "init", "connection-disabled", change("conn-1", { status: "disabled" })],
  ["connection re-owned", { own: OTHER }, "init", "owner-changed"],
  ["no grant", { sub: STRANGER }, "init", "not-owner"],
  ["grant expired", { sub: "0xexpireduid" }, "init", "not-owner"],
  ["backend changed", { conn: "conn-x" }, "init", "backend-changed"],
  ["Author, not enabled here", {}, "author", "fn-not-enabled"],
  ["a grantee, outside the grant", { sub: OTHER }, "save-to-itembank", "not-granted"],
];

describe.each(Object.keys(ENTRY_POINTS))("live refusals through %s", entry => {
  // Each row is one argument: jest reads a test function with more
  // parameters than a row has values as taking a `done` callback.
  it.each(ROWS.map(row => [row[0], row] as const))("%s", async (_name, [, over, fn, expected, changeState]) => {
    const claims = authority(over);
    await changeState?.();
    const outcome = await ENTRY_POINTS[entry](claims, fn);
    const reason = reasonFor(entry, expected);
    expect(outcome).toBe(reason);
    // Every decision is audited with its reason.
    expect(records.at(-1)).toMatchObject(reason === "allowed" ? { outcome: "allowed" } : { outcome: "denied", reason });
  });

  it("has a row for every reason liveRefusal returns", () => {
    expect(new Set(ROWS.map(r => r[3]).filter(r => r !== "allowed"))).toEqual(new Set(REASONS));
  });
});

// Mint stamps the provenance it checked into the execution token, so later
// checks (authorize-execution, Broker) re-read the same authority.
describe("mint stamps the authority's provenance", () => {
  it.each([
    ["the owner", {}, { prv: "user" }],
    ["a grantee", { sub: OTHER }, { prv: "user" }],
    ["a live publication", { pub: "pub-1" }, { prv: "publication", pub: "pub-1" }],
    ["a system preview", SYSTEM, { prv: "system" }],
  ])("%s", async (_name, over, expected) => {
    const sessionToken = await issueToken(signer, "session", { ...authority(over), fns: ["init"] });
    const { executionToken, operationId } = await policy.mint({ caller: L0176, sessionToken, fn: "init", op: OPS.init, occurrenceId: "n1.0", argsDigest: "a".repeat(64) });
    const { claims } = await verifyToken(jwks, "execution", executionToken);
    expect(claims).toMatchObject(expected);
    if (expected.prv !== "publication") expect(claims).not.toHaveProperty("pub");
    expect(provenanceRefusal(claims)).toBeNull();
    // The decision's audit record names the provenance and the operation.
    expect(records.at(-1)).toMatchObject({ event: "mint", outcome: "allowed", provenance: expected.prv, opid: operationId });
  });
});
