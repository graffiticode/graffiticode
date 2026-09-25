import {
  createConnectionManager,
  createMemoryConnectionStore,
  createAudit,
  createPseudonymizer,
  PolicyDenied
} from "./index.js";

const OWNER = "0xowneruid";
const OTHER = "0xotheruid";
const CONSOLE = { role: "console" };
const CRED = { key: "consumer-key", secret: "super-secret-value" };

let manager;
let connections;
let stored;
let records;

beforeEach(() => {
  connections = createMemoryConnectionStore();
  stored = new Map();
  records = [];
  manager = createConnectionManager({
    connections,
    brokerAdmin: {
      putSecret: async (id, cred) => { stored.set(id, cred); },
      deleteSecret: async id => { stored.delete(id); }
    },
    audit: createAudit({ sink: r => records.push(r), pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) })
  });
});

const denied = async (promise, reason) => {
  await expect(promise).rejects.toBeInstanceOf(PolicyDenied);
  await expect(promise).rejects.toMatchObject({ reason });
};
const create = (over = {}) =>
  manager.create({ caller: CONSOLE, user: { uid: OWNER }, backend: "learnosity", label: "Mine", credential: CRED, ...over });

describe("connection lifecycle", () => {
  it("creates a connection: the secret goes to the broker, the record to policy", async () => {
    const created = await create();
    expect(created).toMatchObject({ backend: "learnosity", status: "active", label: "Mine" });
    expect(stored.get(created.connectionId)).toEqual(CRED);
    expect(await connections.get(created.connectionId)).toMatchObject({ ownerUid: OWNER, status: "active" });
    expect(JSON.stringify(created)).not.toContain(CRED.secret);
  });

  it("lists only the owner's connections, without secrets", async () => {
    await create();
    await manager.create({ caller: CONSOLE, user: { uid: OTHER }, backend: "learnosity", credential: CRED });
    const rows = await manager.list({ caller: CONSOLE, user: { uid: OWNER } });
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(["backend", "connectionId", "label", "status"]);
  });

  it("rotates the secret in place and keeps the connection id", async () => {
    const { connectionId } = await create();
    await manager.rotate({ caller: CONSOLE, user: { uid: OWNER }, connectionId, credential: { key: "k2", secret: "s2" } });
    expect(stored.get(connectionId)).toEqual({ key: "k2", secret: "s2" });
  });

  it("disables and removes", async () => {
    const { connectionId } = await create();
    await manager.disable({ caller: CONSOLE, user: { uid: OWNER }, connectionId });
    expect((await connections.get(connectionId)).status).toBe("disabled");
    await manager.remove({ caller: CONSOLE, user: { uid: OWNER }, connectionId });
    expect(await connections.get(connectionId)).toBeNull();
    expect(stored.has(connectionId)).toBe(false);
  });

  it("refuses anyone but the owner, and anyone but the console", async () => {
    const { connectionId } = await create();
    await denied(manager.rotate({ caller: CONSOLE, user: { uid: OTHER }, connectionId, credential: CRED }), "not-owner");
    await denied(manager.disable({ caller: CONSOLE, user: { uid: OTHER }, connectionId }), "not-owner");
    await denied(manager.remove({ caller: CONSOLE, user: { uid: OTHER }, connectionId }), "not-owner");
    await denied(create({ caller: { role: "compiler", lang: "0176" } }), "caller-not-entry-point");
    expect(stored.get(connectionId)).toEqual(CRED);
  });

  it("refuses unknown backends and bad credentials without storing anything", async () => {
    await denied(create({ backend: "nope" }), "unknown-backend");
    await denied(create({ credential: { key: "k" } }), "bad-credential");
    expect(stored.size).toBe(0);
  });

  it("audits lifecycle events without the credential", async () => {
    const { connectionId } = await create();
    await manager.rotate({ caller: CONSOLE, user: { uid: OWNER }, connectionId, credential: CRED });
    await manager.disable({ caller: CONSOLE, user: { uid: OWNER }, connectionId });
    expect(records.map(r => r.event)).toEqual(["connection-create", "connection-rotate", "connection-disable"]);
    const text = JSON.stringify(records);
    expect(text).not.toContain(CRED.secret);
    expect(text).not.toContain(OWNER);
  });
});
