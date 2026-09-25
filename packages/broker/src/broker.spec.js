/* eslint-disable camelcase -- Learnosity wire fields are snake_case */
import { generateKeyPair, exportJWK } from "jose";
import {
  createPolicy,
  createLocalSigner,
  issueToken,
  createMemoryConnectionStore,
  createAudit,
  createPseudonymizer
} from "@graffiticode/policy";
import {
  createBroker,
  BrokerRefused,
  buildOperations,
  createMemoryOnceStore,
  createMemoryReceiptStore,
  createMemorySecretStore,
  argsDigest
} from "./index.js";

const OWNER = "0xowneruid";
const SECRET = "learnosity-secret-value-xyz";
const L0176 = { role: "compiler", lang: "0176" };
const CONSOLE = { role: "console" };

const PREVIEW = {
  id: "t",
  name: "Test",
  session_id: "s1",
  questions: [{ response_id: "artcompiler-mcq-t-0", type: "mcq", stimulus: "Q" }]
};
const WRITE = {
  questionRecords: [{ type: "mcq", reference: "q-0", data: { type: "mcq", stimulus: "Q" } }],
  itemRecords: [{ reference: "graffiticode-t-0", definition: { widgets: [{ reference: "q-0" }] }, status: "unpublished" }]
};

let policy;
let broker;
let receipts;
let routes;
let failItems;
let records;
let otherSigner;
let saveIntent;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  const other = await generateKeyPair("ES256", { extractable: true });
  otherSigner = await createLocalSigner({ privateJwk: await exportJWK(other.privateKey), kid: "k1" });
  records = [];
  const audit = createAudit({
    sink: r => records.push(r),
    pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" })
  });
  const connections = createMemoryConnectionStore([
    { connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" }
  ]);
  policy = createPolicy({ signer, jwks, connections, audit });
  saveIntent = await policy.issueIntent({ caller: CONSOLE, user: { uid: OWNER }, mode: "save", connectionId: "conn-1" });
  routes = [];
  failItems = false;
  const sdk = {
    init: (service, consumer, secret, body, action) => ({ service, consumer, signedWithSecret: secret === SECRET, body, action })
  };
  const dataApi = async ({ route }) => {
    routes.push(route);
    if (failItems && route === "/itembank/items") throw new Error("Learnosity Data API failed: /itembank/items");
    return { meta: { status: true } };
  };
  receipts = createMemoryReceiptStore();
  broker = createBroker({
    jwks,
    operations: buildOperations({ sdk, domain: "l0176.graffiticode.org", dataApi }),
    secrets: createMemorySecretStore({ "conn-1": { key: "consumer-key", secret: SECRET } }),
    once: createMemoryOnceStore(),
    receipts,
    audit
  });
});

const session = (over = {}) => policy.snapshot({
  caller: L0176,
  user: { uid: OWNER },
  lang: "0176",
  connectionId: "conn-1",
  fns: ["preview-itembank", "save-to-itembank", "author-itembank"],
  mode: "read",
  invocationId: "inv-1",
  ...over
}).then(r => r.sessionToken);

const mint = async (sessionToken, { fn, op, payload, occurrenceId = "n1.0" }) =>
  (await policy.mint({ caller: L0176, sessionToken, fn, op, occurrenceId, argsDigest: argsDigest(payload) })).executionToken;

const previewToken = async (payload = PREVIEW) =>
  mint(await session(), { fn: "preview-itembank", op: "learnosity.sign-questions-preview", payload });

const saveToken = async ({ invocationId = "inv-1", payload = WRITE, occurrenceId } = {}) =>
  mint(await session({ intentToken: saveIntent.intentToken, invocationId }), {
    fn: "save-to-itembank",
    op: "learnosity.write-items",
    payload,
    occurrenceId
  });

const refused = async (promise, reason) => {
  await expect(promise).rejects.toBeInstanceOf(BrokerRefused);
  await expect(promise).rejects.toMatchObject({ reason });
};

describe("preview signing", () => {
  it("signs a constrained preview with the broker's own identity fields", async () => {
    const token = await previewToken();
    const { status, result } = await broker.execute({ token, op: "learnosity.sign-questions-preview", payload: PREVIEW });
    expect(status).toBe("succeeded");
    expect(result.request.service).toBe("questions");
    expect(result.request.signedWithSecret).toBe(true);
    expect(result.request.consumer.domain).toBe("l0176.graffiticode.org");
    expect(routes).toEqual([]);
  });

  it("rejects a payload carrying identity or config fields", async () => {
    const payload = { ...PREVIEW, user_id: "someone", security: {} };
    const token = await previewToken(payload);
    await refused(broker.execute({ token, op: "learnosity.sign-questions-preview", payload }), "payload-rejected");
  });

  it("rejects a payload other than the one the token was minted for", async () => {
    const token = await previewToken();
    const payload = { ...PREVIEW, name: "Other" };
    await refused(broker.execute({ token, op: "learnosity.sign-questions-preview", payload }), "args-mismatch");
  });

  it("rejects a token used for a different operation", async () => {
    const token = await previewToken();
    await refused(broker.execute({ token, op: "learnosity.sign-items-preview", payload: PREVIEW }), "operation-mismatch");
  });

  it("never lets a preview token sign Author requests or write", async () => {
    const token = await previewToken();
    await refused(broker.execute({ token, op: "learnosity.sign-author", payload: { reference: "r" } }), "operation-mismatch");
    await refused(broker.execute({ token, op: "learnosity.write-items", payload: WRITE }), "operation-mismatch");
  });

  it("rejects a replayed token", async () => {
    const token = await previewToken();
    await broker.execute({ token, op: "learnosity.sign-questions-preview", payload: PREVIEW });
    await refused(broker.execute({ token, op: "learnosity.sign-questions-preview", payload: PREVIEW }), "token-replayed");
  });

  it("rejects a session token, and a token from another signer", async () => {
    const sessionToken = await session();
    await refused(broker.execute({ token: sessionToken, op: "learnosity.sign-questions-preview", payload: PREVIEW }), "bad-token");
    const forged = await issueToken(otherSigner, "execution", {
      sub: OWNER,
      conn: "conn-1",
      backend: "learnosity",
      lang: "0176",
      mode: "read",
      fn: "preview-itembank",
      op: "learnosity.sign-questions-preview",
      argd: argsDigest(PREVIEW)
    });
    await refused(broker.execute({ token: forged, op: "learnosity.sign-questions-preview", payload: PREVIEW }), "bad-token");
  });
});

describe("item-bank writes", () => {
  it("writes questions, then items, and records the outcome", async () => {
    const token = await saveToken();
    const out = await broker.execute({ token, op: "learnosity.write-items", payload: WRITE });
    expect(out.status).toBe("succeeded");
    expect(out.steps).toEqual(["questions", "items"]);
    expect(routes).toEqual(["/itembank/questions", "/itembank/items"]);
  });

  it("returns the recorded outcome to a retry from a new request, without writing again", async () => {
    await broker.execute({ token: await saveToken({ invocationId: "inv-1" }), op: "learnosity.write-items", payload: WRITE });
    const retry = await broker.execute({ token: await saveToken({ invocationId: "inv-2" }), op: "learnosity.write-items", payload: WRITE });
    expect(retry).toMatchObject({ status: "succeeded", replayed: true });
    expect(routes).toEqual(["/itembank/questions", "/itembank/items"]);
  });

  it("executes once when two fresh tokens for one operation race", async () => {
    const [a, b] = await Promise.all([saveToken({ invocationId: "inv-1" }), saveToken({ invocationId: "inv-2" })]);
    const results = await Promise.all([
      broker.execute({ token: a, op: "learnosity.write-items", payload: WRITE }),
      broker.execute({ token: b, op: "learnosity.write-items", payload: WRITE })
    ]);
    expect(routes).toEqual(["/itembank/questions", "/itembank/items"]);
    expect(results.filter(r => r.replayed)).toHaveLength(1);
  });

  it("gives distinct occurrences in one save their own executions", async () => {
    await broker.execute({ token: await saveToken({ occurrenceId: "n1.0" }), op: "learnosity.write-items", payload: WRITE });
    await broker.execute({ token: await saveToken({ occurrenceId: "n1.1" }), op: "learnosity.write-items", payload: WRITE });
    expect(routes).toHaveLength(4);
  });

  it("reports a failure after the first write as partial, and never re-runs it", async () => {
    failItems = true;
    const first = await broker.execute({ token: await saveToken(), op: "learnosity.write-items", payload: WRITE });
    expect(first).toMatchObject({ status: "partial", steps: ["questions"] });
    failItems = false;
    const retry = await broker.execute({ token: await saveToken({ invocationId: "inv-2" }), op: "learnosity.write-items", payload: WRITE });
    expect(retry).toMatchObject({ status: "partial", replayed: true });
    expect(routes).toEqual(["/itembank/questions", "/itembank/items"]);
  });

  it("reports an attempt that never finished as uncertain", async () => {
    const token = await saveToken();
    await receipts.claim(`${saveIntent.saveActionId}/n1.0`, {
      principal: OWNER,
      connectionId: "conn-1",
      fn: "save-to-itembank",
      op: "learnosity.write-items",
      argsDigest: argsDigest(WRITE)
    });
    const out = await broker.execute({ token, op: "learnosity.write-items", payload: WRITE });
    expect(out).toEqual({ status: "uncertain", replayed: true });
    expect(routes).toEqual([]);
  });

  it("refuses an operation id reused with different arguments", async () => {
    await broker.execute({ token: await saveToken(), op: "learnosity.write-items", payload: WRITE });
    const changed = { ...WRITE, questionRecords: [{ ...WRITE.questionRecords[0], data: { type: "mcq", stimulus: "Changed" } }] };
    const token = await saveToken({ invocationId: "inv-2", payload: changed });
    await refused(broker.execute({ token, op: "learnosity.write-items", payload: changed }), "operation-id-reused");
    expect(routes).toHaveLength(2);
  });

  it("never publishes", async () => {
    const payload = { ...WRITE, itemRecords: [{ ...WRITE.itemRecords[0], status: "published" }] };
    const token = await saveToken({ payload });
    await refused(broker.execute({ token, op: "learnosity.write-items", payload }), "payload-rejected");
  });
});

describe("author signing", () => {
  const authorToken = async payload =>
    mint(await session({
      intentToken: (await policy.issueIntent({ caller: CONSOLE, user: { uid: OWNER }, mode: "author", connectionId: "conn-1" })).intentToken
    }), { fn: "author-itembank", op: "learnosity.sign-author", payload });

  it("builds a fixed request from the reference and allowed widget types", async () => {
    const payload = { reference: "graffiticode-t-0", widgetTypes: ["mcq"] };
    const { result } = await broker.execute({ token: await authorToken(payload), op: "learnosity.sign-author", payload });
    expect(result.request.service).toBe("author");
    expect(result.request.body.mode).toBe("item_edit");
    expect(result.request.body.reference).toBe("graffiticode-t-0");
  });

  it("rejects caller config and widget types outside the allowlist", async () => {
    const withConfig = { reference: "r", config: { item_list: {} } };
    await refused(broker.execute({ token: await authorToken(withConfig), op: "learnosity.sign-author", payload: withConfig }), "payload-rejected");
    const badWidget = { reference: "r", widgetTypes: ["anything"] };
    await refused(broker.execute({ token: await authorToken(badWidget), op: "learnosity.sign-author", payload: badWidget }), "payload-rejected");
  });
});

describe("audit", () => {
  it("records decisions without tokens, secrets or raw ids", async () => {
    const token = await previewToken();
    await broker.execute({ token, op: "learnosity.sign-questions-preview", payload: PREVIEW });
    await broker.execute({ token, op: "learnosity.sign-questions-preview", payload: PREVIEW }).catch(() => {});
    const text = JSON.stringify(records);
    expect(text).not.toContain(token);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(OWNER);
    expect(records.filter(r => r.event === "execute").map(r => r.outcome)).toEqual(["allowed", "denied"]);
  });
});
