import { parseCallers, parseEnabledGatedFunctions, parseEnabledGatedOperations, parseSystemConnections, requireEnv } from "./config.js";

describe("service configuration", () => {
  it("parses a caller map", () => {
    const callers = parseCallers(JSON.stringify({
      "l0176-run@graffiticode.iam.gserviceaccount.com": { role: "compiler", lang: "0176", extra: "ignored" },
      "console-run@graffiticode-app.iam.gserviceaccount.com": { role: "console" }
    }));
    expect(callers["l0176-run@graffiticode.iam.gserviceaccount.com"]).toEqual({ role: "compiler", lang: "0176" });
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

  // AUTHOR-01: gated functions stay disabled unless explicitly listed; the
  // production setting is empty until provider evidence is recorded.
  it("parses enabled gated functions, and treats an absent or empty setting as none", () => {
    const enabled = parseEnabledGatedFunctions(JSON.stringify(["0176:author", "L0176:author"]));
    expect([...enabled]).toEqual(["0176:author"]);
    expect(Object.isFrozen(enabled)).toBe(true);
    expect(parseEnabledGatedFunctions(undefined).size).toBe(0);
    expect(parseEnabledGatedFunctions("").size).toBe(0);
    expect(parseEnabledGatedFunctions("[]").size).toBe(0);
  });

  it.each([
    ["not JSON", "["],
    ["an object", JSON.stringify({ "0176": "author" })],
    ["a malformed entry", JSON.stringify(["author"])],
    ["an unknown function", JSON.stringify(["0176:no-such-fn"])],
    ["a function that is not gated", JSON.stringify(["0176:init"])],
    ["a non-string entry", JSON.stringify([176])]
  ])("refuses enabled gated functions given %s", (_, json) => {
    expect(() => parseEnabledGatedFunctions(json)).toThrow(/POLICY_ENABLED_GATED_FUNCTIONS/);
  });

  it("requires settings to be present", () => {
    expect(() => requireEnv({}, "X")).toThrow(/X is required/);
    expect(() => requireEnv({ X: " " }, "X")).toThrow();
    expect(requireEnv({ X: "v" }, "X")).toBe("v");
  });

  it("parses enabled gated operations, and treats an absent or empty setting as none", () => {
    expect([...parseEnabledGatedOperations(JSON.stringify(["learnosity.sign-author"]))]).toEqual(["learnosity.sign-author"]);
    expect(parseEnabledGatedOperations(undefined).size).toBe(0);
    expect(parseEnabledGatedOperations("").size).toBe(0);
    expect(parseEnabledGatedOperations("[]").size).toBe(0);
  });

  it.each([
    ["not JSON", "["],
    ["an object", JSON.stringify({ op: "learnosity.sign-author" })],
    ["an unknown operation", JSON.stringify(["learnosity.no-such-op"])],
    ["an operation that is not gated", JSON.stringify(["learnosity.write-items"])],
    ["a non-string entry", JSON.stringify([1])]
  ])("refuses enabled gated operations given %s", (_, json) => {
    expect(() => parseEnabledGatedOperations(json)).toThrow(/BROKER_ENABLED_GATED_OPERATIONS/);
  });
});
