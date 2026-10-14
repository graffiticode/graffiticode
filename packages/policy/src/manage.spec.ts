import {
  createConnectionManager,
  createMemoryConnectionStore,
  createAudit,
  createPseudonymizer,
  PolicyDenied
} from "./index.js";
import { BrokerConflict } from "./broker-admin.js";

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
      createSecret: async (id, cred) => { stored.set(id, cred); },
      rotateSecret: async (id, cred) => {
        if (stored.get(id).key !== cred.key) throw new BrokerConflict("changed");
        stored.set(id, cred);
      },
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
    expect(stored.get(created.connectionId)).toEqual({ ownerUid: OWNER, backend: "learnosity", ...CRED });
    expect(await connections.get(created.connectionId)).toMatchObject({ ownerUid: OWNER, status: "active" });
    expect(JSON.stringify(created)).not.toContain(CRED.secret);
  });

  it("lists only the owner's connections, without secrets", async () => {
    await create();
    await manager.create({ caller: CONSOLE, user: { uid: OTHER }, backend: "learnosity", credential: CRED });
    const rows = await manager.list({ caller: CONSOLE, user: { uid: OWNER } });
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(["backend", "connectionId", "label", "ownerPermissions", "status", "system"]);
    expect(rows[0].ownerPermissions).toBeNull();
    expect(rows[0].system).toBe(false);
  });

  it("marks a configured system connection in the owner's list", async () => {
    const mine = await create();
    const other = await create({ label: "Other" });
    const sysManager = createConnectionManager({
      connections,
      brokerAdmin: { createSecret: async () => {}, rotateSecret: async () => {}, deleteSecret: async () => {} },
      audit: async () => {},
      systemConnections: { learnosity: mine.connectionId }
    });
    const rows = await sysManager.list({ caller: CONSOLE, user: { uid: OWNER } });
    const byId = Object.fromEntries(rows.map(r => [r.connectionId, r.system]));
    expect(byId).toEqual({ [mine.connectionId]: true, [other.connectionId]: false });
  });

  it("rotates the secret in place, keeping the connection id, owner and backend", async () => {
    const { connectionId } = await create();
    await manager.rotate({ caller: CONSOLE, user: { uid: OWNER }, connectionId, credential: { key: CRED.key, secret: "s2" } });
    expect(stored.get(connectionId)).toEqual({ ownerUid: OWNER, backend: "learnosity", key: CRED.key, secret: "s2" });
  });

  it("refuses a rotation the broker rejects as a different provider account", async () => {
    const { connectionId } = await create();
    await denied(
      manager.rotate({ caller: CONSOLE, user: { uid: OWNER }, connectionId, credential: { key: "another-account", secret: "s2" } }),
      "provider-account-changed"
    );
    expect(stored.get(connectionId).key).toBe(CRED.key);
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
    expect(stored.get(connectionId)).toEqual({ ownerUid: OWNER, backend: "learnosity", ...CRED });
  });

  it("refuses unknown backends and bad credentials without storing anything", async () => {
    await denied(create({ backend: "nope" }), "unknown-backend");
    await denied(create({ credential: { key: "k" } }), "bad-credential");
    expect(stored.size).toBe(0);
  });

  it("stores no record when the broker refuses the secret", async () => {
    const failing = createConnectionManager({
      connections,
      brokerAdmin: { createSecret: async () => { throw new Error("broker down"); }, rotateSecret: async () => {}, deleteSecret: async () => {} },
      audit: async () => {}
    });
    await expect(failing.create({ caller: CONSOLE, user: { uid: OWNER }, backend: "learnosity", credential: CRED })).rejects.toThrow("broker down");
    expect(await connections.listByOwner(OWNER)).toEqual([]);
  });

  // A record store whose put fails after the broker has the secret.
  const withFailingPut = (deleteSecret = async id => { stored.delete(id); }) => {
    const deleted = [];
    const failing = createConnectionManager({
      connections: { ...connections, put: async () => { throw new Error("firestore down"); } },
      brokerAdmin: {
        createSecret: async (id, cred) => { stored.set(id, cred); },
        rotateSecret: async () => {},
        deleteSecret: async id => { deleted.push(id); await deleteSecret(id); }
      },
      audit: createAudit({ sink: r => records.push(r), pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) })
    });
    return { failing, deleted };
  };

  it("deletes the secret again when the record can't be stored", async () => {
    const { failing, deleted } = withFailingPut();
    await expect(failing.create({ caller: CONSOLE, user: { uid: OWNER }, backend: "learnosity", credential: CRED })).rejects.toThrow("firestore down");
    expect(deleted).toHaveLength(1);
    expect(stored.size).toBe(0);
    expect(await connections.get(deleted[0])).toBeNull();
    expect(records).toEqual([expect.objectContaining({ event: "connection-create", connectionId: deleted[0], outcome: "failed", reason: "storage-failed" })]);
  });

  it("surfaces the store's error even when the cleanup fails", async () => {
    const { failing, deleted } = withFailingPut(async () => { throw new Error("broker down"); });
    await expect(failing.create({ caller: CONSOLE, user: { uid: OWNER }, backend: "learnosity", credential: CRED })).rejects.toThrow("firestore down");
    expect(deleted).toHaveLength(1);
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
