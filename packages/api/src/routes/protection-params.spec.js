import { parseConnectionId, parsePublicationId } from "./utils.js";

describe("protection parameters", () => {
  it("accepts a well-formed connection for an authenticated caller", () => {
    expect(parseConnectionId("conn-1", { auth: { uid: "u" } })).toBe("conn-1");
    expect(parseConnectionId(undefined, { auth: null })).toBeNull();
  });

  it("refuses a connection from an anonymous caller, or a malformed one", () => {
    expect(() => parseConnectionId("conn-1", { auth: null })).toThrow();
    expect(() => parseConnectionId("../x", { auth: { uid: "u" } })).toThrow();
  });

  it("accepts only a publication id's shape, from anyone", () => {
    expect(parsePublicationId("pub-0a1b2c3d-1234")).toBe("pub-0a1b2c3d-1234");
    expect(parsePublicationId(undefined)).toBeNull();
    expect(() => parsePublicationId("inv-1")).toThrow();
    expect(() => parsePublicationId("pub-../x")).toThrow();
  });
});
