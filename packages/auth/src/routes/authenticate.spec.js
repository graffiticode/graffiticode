import { privateToAddress, stripHexPrefix } from "@ethereumjs/util";
import { createSignature } from "../services/ethereum.js";
import { startAuthApp } from "../testing/app.js";
import { generateNonce } from "../utils.js";

describe("routes/authenticate", () => {
  const privateKey = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex");
  const address = privateToAddress(privateKey).toString("hex");

  let authApp;
  let client;
  beforeEach(async () => {
    authApp = await startAuthApp();
    client = authApp.client;
  });

  afterEach(async () => {
    await authApp.cleanUp();
  });

  describe("ethereum", () => {
    describe("get ethereum nonce", () => {
      it("GET should return 400 for invalid address", async () => {
        await expect(client.ethereum.getNonce({ address: "foo" }))
          .rejects.toThrow("invalid address");
      });

      it("should get nonce for address", async () => {
        await expect(client.ethereum.getNonce({ address }))
          .resolves.toEqual(expect.any(String));
      });
    });

    describe("authenticate with ethereum", () => {
      it("POST should return 400 for invalid address", async () => {
        const nonce = await client.ethereum.getNonce({ address });
        const signature = createSignature({ privateKey, nonce });

        await expect(client.ethereum.authenticate({ address: "foo", nonce, signature }))
          .rejects.toThrow("invalid address");
      });

      it("should return 400 if no nonce ", async () => {
        const nonce = await client.ethereum.getNonce({ address });
        const signature = createSignature({ privateKey, nonce });

        await expect(client.ethereum.authenticate({ address, signature }))
          .rejects.toThrow("must provide a nonce");
      });

      it("should return 400 if no signature ", async () => {
        const nonce = await client.ethereum.getNonce({ address });

        await expect(client.ethereum.authenticate({ address, nonce }))
          .rejects.toThrow("must provide a signature");
      });

      it("should return 400 if nonce is different ", async () => {
        const nonce = await generateNonce();
        const signature = createSignature({ privateKey, nonce });

        await expect(client.ethereum.authenticate({ address, nonce, signature }))
          .rejects.toThrow("nonce does not match");
      });

      it("should return 400 if invalid signature ", async () => {
        const nonce = await client.ethereum.getNonce({ address });

        await expect(client.ethereum.authenticate({ address, nonce, signature: "0xdeadbeef" }))
          .rejects.toThrow("invalid signature");
      });

      it("should return 401 if incorrect signature ", async () => {
        const privateKey2 = Buffer.from("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "hex");
        const nonce = await client.ethereum.getNonce({ address });
        const signature = createSignature({ privateKey: privateKey2, nonce });

        await expect(client.ethereum.authenticate({ address, nonce, signature }))
          .rejects.toThrow("address mismatch");
      });

      it("should authenticate with ethereum", async () => {
        const nonce = await client.ethereum.getNonce({ address });
        const signature = createSignature({ privateKey, nonce });

        const { refresh_token, access_token } = await client.ethereum.authenticate({ address, nonce, signature });

        await expect(client.verifyAccessToken(access_token)).resolves.toHaveProperty("uid", address);
        const { access_token: access_token2 } = await client.exchangeRefreshToken(refresh_token);
        await expect(client.verifyAccessToken(access_token2)).resolves.toHaveProperty("uid", address);
      });

      it("should authenticate non 0x prefixed signature", async () => {
        const nonce = await client.ethereum.getNonce({ address });
        const signature = stripHexPrefix(createSignature({ privateKey, nonce }));

        const { refresh_token, access_token } = await client.ethereum.authenticate({ address, nonce, signature });

        await expect(client.verifyAccessToken(access_token)).resolves.toHaveProperty("uid", address);
        const { access_token: access_token2 } = await client.exchangeRefreshToken(refresh_token);
        await expect(client.verifyAccessToken(access_token2)).resolves.toHaveProperty("uid", address);
      });

      it("should authenticate after key rotation", async () => {
        const nonce = await client.ethereum.getNonce({ address });
        const signature = createSignature({ privateKey, nonce });

        const { refresh_token, access_token } = await client.ethereum.authenticate({ address, nonce, signature });
        await authApp.keys.rotateKey();

        await expect(client.verifyAccessToken(access_token)).resolves.toHaveProperty("uid", address);
        const { access_token: access_token2 } = await client.exchangeRefreshToken(refresh_token);
        await expect(client.verifyAccessToken(access_token2)).resolves.toHaveProperty("uid", address);
      });

      it("should authenticate case insensitive", async () => {
        const nonce = await client.ethereum.getNonce({ address });
        const signature = createSignature({ privateKey, nonce });

        const { refresh_token, access_token } = await client.ethereum.authenticate({ address: address.toUpperCase(), nonce, signature });

        await expect(client.verifyAccessToken(access_token)).resolves.toHaveProperty("uid", address);
        const { access_token: access_token2 } = await client.exchangeRefreshToken(refresh_token);
        await expect(client.verifyAccessToken(access_token2)).resolves.toHaveProperty("uid", address);
      });
    });
  });
});
