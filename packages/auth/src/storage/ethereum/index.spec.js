import { cleanUpFirebase } from "../../testing/firebase.js";
import { createEthereumStorer } from "./index.js";

describe.each(["memory", "firestore"])("storage/ethereum[%s]", (type) => {
  const myAddress = "abc123";
  const otherAddress = "def456";

  let storer;
  beforeEach(async () => {
    storer = createEthereumStorer(type);
  });

  afterEach(cleanUpFirebase);

  it("should get existing nonce for address", async () => {
    await storer.rotateNonce({ address: myAddress });

    await expect(storer.getNonce({ address: myAddress })).resolves.toStrictEqual(expect.any(String));
  });

  it("should get nonce if not reset", async () => {
    await expect(storer.getNonce({ address: myAddress })).resolves.toStrictEqual(expect.any(String));
  });

  it("should get same nonce with no reset", async () => {
    await storer.rotateNonce({ address: myAddress });

    const nonce1 = await storer.getNonce({ address: myAddress });
    const nonce2 = await storer.getNonce({ address: myAddress });

    expect(nonce1).toEqual(nonce2);
  });

  it("should ignore address case when getting nonce", async () => {
    const nonce1 = await storer.getNonce({ address: myAddress.toLowerCase() });
    const nonce2 = await storer.getNonce({ address: myAddress.toUpperCase() });

    expect(nonce1).toEqual(nonce2);
  });

  it("should ignore address case when reseting nonce", async () => {
    const nonce1 = await storer.getNonce({ address: myAddress.toLowerCase() });
    await storer.rotateNonce({ address: myAddress.toUpperCase() });
    const nonce2 = await storer.getNonce({ address: myAddress.toLowerCase() });

    expect(nonce1).not.toEqual(nonce2);
  });

  it("should get different nonce after reset", async () => {
    const nonce1 = await storer.getNonce({ address: myAddress });
    storer.rotateNonce({ address: myAddress });
    const nonce2 = await storer.getNonce({ address: myAddress });

    expect(nonce1).not.toEqual(nonce2);
  });

  it("should get different nonce for different addresses", async () => {
    const nonce1 = await storer.getNonce({ address: myAddress });
    const nonce2 = await storer.getNonce({ address: otherAddress });

    expect(nonce1).not.toEqual(nonce2);
  });
});
