import { parseConnectionId, parseIntentToken } from "./utils.js";

describe("protection parameters", () => {
  it("accepts a well-formed connection for an authenticated caller", () => {
    expect(parseConnectionId("conn-1", { auth: { uid: "u" } })).toBe("conn-1");
    expect(parseConnectionId(undefined, { auth: null })).toBeNull();
  });

  it("refuses a connection from an anonymous caller, or a malformed one", () => {
    expect(() => parseConnectionId("conn-1", { auth: null })).toThrow();
    expect(() => parseConnectionId("../x", { auth: { uid: "u" } })).toThrow();
  });

  it("accepts a JWT-shaped intent only with a connection", () => {
    expect(parseIntentToken("a.b.c", { connectionId: "conn-1" })).toBe("a.b.c");
    expect(parseIntentToken(undefined, { connectionId: null })).toBeNull();
    expect(() => parseIntentToken("a.b.c", { connectionId: null })).toThrow();
    expect(() => parseIntentToken("not a jwt", { connectionId: "conn-1" })).toThrow();
    expect(() => parseIntentToken("a".repeat(5000) + ".b.c", { connectionId: "conn-1" })).toThrow();
  });
});
