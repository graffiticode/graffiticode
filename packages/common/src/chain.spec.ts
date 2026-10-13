// The canonical task chain (W4): every encoding of one chain decodes to the
// same ordered task list, the one chain admission compares.
import { decodeChainId, encodeChainId, ChainIdError } from "./chain.js";

// api's own encoding (packages/api/src/storage/tasks.js encodeId).
const apiEncode = taskIds => Buffer.from(JSON.stringify({ taskIds }), "utf8").toString("base64url");

describe("chain ids", () => {
  it("decode every encoding of a chain to one ordered task list", () => {
    const whole = encodeChainId(["a", "b", "c"]);
    expect(whole).toBe(apiEncode(["a", "b", "c"]));
    expect(decodeChainId(whole)).toEqual(["a", "b", "c"]);
    expect(decodeChainId(`${apiEncode(["a"])}+${apiEncode(["b", "c"])}`)).toEqual(["a", "b", "c"]);
    // A query string turns + into a space.
    expect(decodeChainId(`${apiEncode(["a", "b"])} ${apiEncode(["c"])}`)).toEqual(["a", "b", "c"]);
  });

  it("refuse what isn't a chain", () => {
    for (const bad of ["", "not-an-id", apiEncode([]), Buffer.from("{}").toString("base64url"), apiEncode([1])]) {
      expect(() => decodeChainId(bad)).toThrow(ChainIdError);
    }
  });
});
