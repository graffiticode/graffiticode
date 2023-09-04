import { privateToAddress } from "@ethereumjs/util";
import { startAuthApp } from "@graffiticode/auth/testing";
import { createClient } from "./index.js";
import { createSignature } from "./ethereum.js";

describe("ethereum", () => {
  const privateKey = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex");
  const address = Buffer.from(privateToAddress(privateKey)).toString("hex");

  let authApp;
  let client;

  beforeEach(async () => {
    authApp = await startAuthApp();
    client = createClient({ url: authApp.url });
  });

  afterEach(async () => {
    await authApp.cleanUp();
  });

  describe("getEthereumNonce", () => {
    it("should throw if address is not present", async () => {
      await expect(client.getEthereumNonce({})).rejects.toThrow("must provide an address");
    });

    it("should return address nonce", async () => {
      const nonce = await client.getEthereumNonce({ address });

      const expectedNonce = await authApp.ethereumService.getNonce({ address });
      expect(nonce).toBe(expectedNonce);
    });

    it("should return same address nonce", async () => {
      const nonce1 = await client.getEthereumNonce({ address });
      const nonce2 = await client.getEthereumNonce({ address });

      expect(nonce1).toBe(nonce2);
    });
  });

  describe("authenticate", () => {
    it("should throw if address is not present", async () => {
      const nonce = await client.getEthereumNonce({ address });
      const signature = createSignature({ privateKey, nonce });

      await expect(client.signInWithEthereum({ nonce, signature })).rejects.toThrow("must provide an address");
    });

    it("should throw if nonce is not present", async () => {
      const nonce = await client.getEthereumNonce({ address });
      const signature = createSignature({ privateKey, nonce });

      await expect(client.signInWithEthereum({ address, signature })).rejects.toThrow("must provide a nonce");
    });

    it("should throw if signature is not present", async () => {
      const nonce = await client.getEthereumNonce({ address });

      await expect(client.signInWithEthereum({ address, nonce })).rejects.toThrow("must provide a signature");
    });

    it("should throw if mismatch nonce", async () => {
      const nonce = await client.getEthereumNonce({ address });
      const signature = createSignature({ privateKey, nonce });

      await expect(client.signInWithEthereum({ address, nonce: "other-nonce", signature }))
        .rejects.toThrow("nonce does not match");
    });
  });
});
