import { createAudit, createPseudonymizer, validateAuditRecord, requestContextMiddleware } from "./index.js";

const UID = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const capture = () => {
  const records = [];
  const audit = createAudit({ sink: r => records.push(r), pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) });
  return { records, audit };
};

describe("audit values (spec AUDIT-01)", () => {
  it("keeps registry names, bounded ids and listed values", () => {
    const valid = {
      event: "authorize-execution",
      outcome: "allowed",
      lang: "0176",
      fn: "save-to-itembank",
      op: "learnosity.write-items",
      step: "items",
      purpose: "dispatch",
      steps: ["questions"],
      failedStep: "items",
      connectionId: "conn-1",
      invocationId: "inv-9baeae72-b120",
      stage: "s0",
      opid: "inv-9baeae72-b120/s0/n1.0",
      provenance: "user",
      callerRole: "broker",
      reason: "authorization-denied:token-expired",
      category: "authentication",
      registryVersion: 6,
    };
    expect(validateAuditRecord(valid)).toEqual(valid);
  });

  // A refused request can put anything in a field a record copies.
  it.each([
    ["op", { op: "alice@example.com" }],
    ["op", { op: "learnosity.write-items; DROP" }],
    ["fn", { lang: "0176", fn: "<script>secret</script>" }],
    ["fn", { lang: "0176", fn: "author " }],
    ["step", { op: "learnosity.write-items", step: "What is 2+2?" }],
    ["step", { op: "learnosity.sign-items-preview", step: "questions" }],
    ["purpose", { purpose: "exfiltrate" }],
    ["connectionId", { connectionId: UID }],
    ["connectionId", { connectionId: "alice@example.com" }],
    ["invocationId", { invocationId: "inv-" + "x".repeat(200) }],
    ["opid", { opid: `${UID}/s0/n1` }],
    ["stage", { stage: UID }],
    ["reason", { reason: "free text with an email alice@example.com" }],
    ["reason", { reason: "authorization-denied:alice@example.com" }],
    ["callerRole", { callerRole: "admin" }],
    ["outcome", { outcome: "ok!" }],
    ["event", { event: "Event With Spaces" }],
  ])("records an invalid %s as \"invalid\", never as given", (field, record) => {
    const out = validateAuditRecord(record);
    expect(out[field]).toBe("invalid");
    expect(JSON.stringify(out)).not.toMatch(/@|0x5aAeb|What is|script|DROP|exfiltrate/);
  });

  it("validates each of several steps, and drops fields it doesn't know", () => {
    expect(validateAuditRecord({ op: "learnosity.write-items", steps: ["questions", "mallory@example.com"], token: "eyJhbGciOi", payload: { x: 1 } }))
      .toEqual({ op: "learnosity.write-items", steps: ["questions", "invalid"] });
  });

  it("pseudonymizes uid and owner, and never writes them raw", () => {
    const { records, audit } = capture();
    audit({ event: "mint", outcome: "allowed", uid: UID, ownerUid: UID });
    expect(records[0].user).toMatch(/^[0-9a-f]{24}$/);
    expect(JSON.stringify(records)).not.toContain(UID);
  });

  it("stamps the request's server-generated id on every record written within it", async () => {
    const { records, audit } = capture();
    await new Promise<void>(resolve => requestContextMiddleware({}, {}, () => { audit({ event: "snapshot", outcome: "denied", reason: "no-user" }); audit({ event: "snapshot", outcome: "denied", reason: "no-user" }); resolve(); }));
    await new Promise<void>(resolve => requestContextMiddleware({}, {}, () => { audit({ event: "snapshot", outcome: "denied", reason: "no-user" }); resolve(); }));
    expect(records[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(records[1].requestId).toBe(records[0].requestId);
    expect(records[2].requestId).not.toBe(records[0].requestId);
    // Outside any request, no id.
    audit({ event: "snapshot", outcome: "denied", reason: "no-user" });
    expect(records[3]).not.toHaveProperty("requestId");
  });
});
