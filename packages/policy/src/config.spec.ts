import { parseCallers, parseSystemConnections, refuseRemovedSettings, requireEnv } from "./config.js";

describe("service configuration", () => {
  it("parses a caller map", () => {
    const callers = parseCallers(JSON.stringify({
      "l0176-run@graffiticode.iam.gserviceaccount.com": { role: "compiler", lang: "0176", extra: "ignored" },
      "console-run@graffiticode-app.iam.gserviceaccount.com": { role: "console" },
      "broker-run@graffiticode.iam.gserviceaccount.com": { role: "broker", lang: "0176" }
    }));
    expect(callers["l0176-run@graffiticode.iam.gserviceaccount.com"]).toEqual({ role: "compiler", lang: "0176" });
    // A broker holds no language: it executes for every compiler.
    expect(callers["broker-run@graffiticode.iam.gserviceaccount.com"]).toEqual({ role: "broker" });
    expect(Object.isFrozen(callers)).toBe(true);
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["a user email", JSON.stringify({ "someone@example.com": { role: "console" } })],
    ["an unknown role", JSON.stringify({ "x@p.iam.gserviceaccount.com": { role: "admin" } })],
    ["a compiler without a language", JSON.stringify({ "x@p.iam.gserviceaccount.com": { role: "compiler" } })]
  ])("refuses %s", (_, json) => {
    expect(() => parseCallers(json)).toThrow();
  });

  it("parses system connections, and treats an absent or empty setting as none", () => {
    const parsed = parseSystemConnections(JSON.stringify({ learnosity: "conn-sys" }));
    expect(parsed).toEqual({ learnosity: "conn-sys" });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parseSystemConnections(undefined)).toEqual({});
    expect(parseSystemConnections("")).toEqual({});
    expect(parseSystemConnections("{}")).toEqual({});
  });

  it.each([
    ["not JSON", "{"],
    ["an array", JSON.stringify(["conn-sys"])],
    ["a string", JSON.stringify("conn-sys")],
    ["an unknown backend", JSON.stringify({ other: "conn-sys" })],
    ["a non-string id", JSON.stringify({ learnosity: 7 })],
    ["an empty id", JSON.stringify({ learnosity: "" })],
    ["an id policy would refuse", JSON.stringify({ learnosity: "conn/sys" })]
  ])("refuses system connections given %s", (_, json) => {
    expect(() => parseSystemConnections(json)).toThrow(/POLICY_SYSTEM_CONNECTIONS/);
  });

  // Registry v7 removed Author signing and the settings that enabled it: a
  // deployment still setting one stops rather than appear to enable something.
  it.each(["POLICY_ENABLED_GATED_FUNCTIONS", "BROKER_ENABLED_GATED_OPERATIONS"])("refuses to start with the removed %s set", name => {
    expect(() => refuseRemovedSettings({ [name]: "[\"0176:author\"]" })).toThrow(new RegExp(`${name} no longer exist`));
    expect(() => refuseRemovedSettings({ [name]: "[]" })).toThrow(new RegExp(name));
  });

  it("starts with the removed settings absent or empty", () => {
    expect(() => refuseRemovedSettings({})).not.toThrow();
    expect(() => refuseRemovedSettings({ POLICY_ENABLED_GATED_FUNCTIONS: "", BROKER_ENABLED_GATED_OPERATIONS: " " })).not.toThrow();
  });

  it("requires settings to be present", () => {
    expect(() => requireEnv({}, "X")).toThrow(/X is required/);
    expect(() => requireEnv({ X: " " }, "X")).toThrow();
    expect(requireEnv({ X: "v" }, "X")).toBe("v");
  });
});
