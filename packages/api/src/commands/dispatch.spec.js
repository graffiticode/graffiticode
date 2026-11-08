// D2a across paths (B5 slice 7): a command's key on /compile is answered from
// its record; a legacy key's compile is answered as a command outcome.
import { buildCommandEnvelope, legacyOutcome, commandIdFor } from "./dispatch.js";
import { PolicyRefused } from "./policy-commands.js";

describe("a command's key on /compile", () => {
  const policyWith = (state, text = JSON.stringify({ count: 2 })) => ({
    get: async ({ commandId, authToken }) => {
      if (authToken !== "user-token") throw new PolicyRefused("command-not-found");
      return { commandId, ...state };
    },
    read: async () => ({ result: { text } }),
  });

  it("answers the command's result when it completed with one, never compiling", async () => {
    const envelope = await buildCommandEnvelope({ policy: policyWith({ status: "completed", result: { state: "available" } }) })({ uid: "u1", idempotencyKey: "k1", authToken: "user-token" });
    expect(envelope).toEqual({ data: { count: 2 }, errors: [], command: { commandId: commandIdFor("u1", "k1"), outcome: "completed", statusUrl: `/command/${encodeURIComponent(commandIdFor("u1", "k1"))}` } });
  });

  it("answers the outcome and where to read it otherwise", async () => {
    for (const state of [{ status: "pending" }, { status: "partial" }, { status: "completed", result: { state: "unavailable" } }]) {
      const envelope = await buildCommandEnvelope({ policy: policyWith(state) })({ uid: "u1", idempotencyKey: "k1", authToken: "user-token" });
      expect(envelope.errors[0]).toMatchObject({ code: "command-protocol" });
      expect(envelope.command.outcome).toBe(state.status);
      expect(envelope.data).toBeUndefined();
    }
  });

  it("serves only the user's own command", async () => {
    const envelope = await buildCommandEnvelope({ policy: policyWith({ status: "completed" }) })({ uid: "u1", idempotencyKey: "k1", authToken: "someone-else" });
    expect(envelope.errors[0].code).toBe("command-not-found");
  });

  it("names a key's command as Policy does", () => {
    expect(commandIdFor("0xu", "job-1")).toMatch(/^c:[a-f0-9]{64}$/);
  });
});

describe("legacyOutcome", () => {
  const with_ = (statuses, extra = {}) => ({ effects: statuses.map(status => ({ status })), errors: [], ...extra });
  it("aggregates a legacy compile's writes as a command's would be", () => {
    expect(legacyOutcome(with_([]))).toBe("completed");
    expect(legacyOutcome(with_([], { errors: [{}] }))).toBe("failed");
    expect(legacyOutcome(with_(["succeeded", "succeeded"]))).toBe("completed");
    expect(legacyOutcome(with_(["failed"], { errors: [{}] }))).toBe("failed");
    expect(legacyOutcome(with_(["succeeded", "failed"], { errors: [{}] }))).toBe("partial");
    expect(legacyOutcome(with_(["succeeded", "uncertain"]))).toBe("uncertain");
    expect(legacyOutcome(with_(["succeeded"], { responseLost: true }))).toBe("uncertain");
  });
});
