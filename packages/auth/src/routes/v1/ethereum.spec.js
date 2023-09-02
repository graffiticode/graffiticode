import { addHexPrefix, privateToAddress, stripHexPrefix } from "@ethereumjs/util";
import request from "supertest";
import { createSignature } from "../../services/ethereum.js";
import { startAuthApp } from "../../testing/app.js";
import { generateNonce } from "../../utils.js";

describe("routes/v1/ethereum", () => {
  const privateKey = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex");
  const address = privateToAddress(privateKey).toString("hex");

  let authApp;
  beforeEach(async () => {
    authApp = await startAuthApp();
  });

  afterEach(async () => {
    await authApp.cleanUp();
  });

  describe("get", () => {
    it("GET should return invalid argument for invalid address", async () => {
      const res = await request(authApp.app)
        .get("/v1/ethereum/deadbeef")
        .expect(400);

      expect(res.body).toHaveProperty(
        "error.message",
        expect.stringContaining("invalid ethereum address")
      );
    });

    it("should should return nonce for address", async () => {
      const res = await request(authApp.app)
        .get(`/v1/ethereum/${address}`)
        .expect(200);

      expect(res.body).toHaveProperty("status", "success");
      const expectedNonce = await authApp.ethereumStorer.getNonce({ address });
      expect(res.body).toHaveProperty("data.nonce", expectedNonce);
    });
  });

  describe("authenticate", () => {
    it("should return invalid argument for invalid address", async () => {
      const res = await request(authApp.app)
        .post("/v1/ethereum/deadbeef/authenticate")
        .send({})
        .expect(400);

      expect(res.body).toHaveProperty(
        "error.message",
        expect.stringContaining("invalid ethereum address")
      );
    });

    it("should return invalid argument for missing nonce", async () => {
      const nonce = await authApp.ethereumStorer.getNonce({ address });
      const signature = createSignature({ privateKey, nonce });

      const res = await request(authApp.app)
        .post(`/v1/ethereum/${address}/authenticate`)
        .send({ signature })
        .expect(400);

      expect(res.body).toHaveProperty(
        "error.message",
        expect.stringContaining("must provide a nonce")
      );
    });

    it("should return invalid argument for missing signature", async () => {
      const nonce = await authApp.ethereumStorer.getNonce({ address });

      const res = await request(authApp.app)
        .post(`/v1/ethereum/${address}/authenticate`)
        .send({ nonce })
        .expect(400);

      expect(res.body).toHaveProperty(
        "error.message",
        expect.stringContaining("must provide a signature")
      );
    });

    it("should return invalid argument for nonce mismatch", async () => {
      const nonce = await generateNonce();
      const signature = createSignature({ privateKey, nonce });

      const res = await request(authApp.app)
        .post(`/v1/ethereum/${address}/authenticate`)
        .send({ nonce, signature })
        .expect(400);

      expect(res.body).toHaveProperty(
        "error.message",
        expect.stringContaining("nonce does not match")
      );
    });

    it("should return invalid argument for an invalid signature", async () => {
      const nonce = await authApp.ethereumStorer.getNonce({ address });

      const res = await request(authApp.app)
        .post(`/v1/ethereum/${address}/authenticate`)
        .send({ nonce, signature: "0xdeadbeef" })
        .expect(400);

      expect(res.body).toHaveProperty(
        "error.message",
        expect.stringContaining("invalid signature")
      );
    });

    it("should return invalid argument for an invalid signature", async () => {
      const nonce = await authApp.ethereumStorer.getNonce({ address });

      const res = await request(authApp.app)
        .post(`/v1/ethereum/${address}/authenticate`)
        .send({ nonce, signature: "0xdeadbeef" })
        .expect(400);

      expect(res.body).toHaveProperty(
        "error.message",
        expect.stringContaining("invalid signature")
      );
    });

    it("should return 401 if incorrect signature ", async () => {
      const privateKey2 = Buffer.from("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "hex");
      const nonce = await authApp.ethereumStorer.getNonce({ address });
      const signature = createSignature({ privateKey: privateKey2, nonce });

      const res = await request(authApp.app)
        .post(`/v1/ethereum/${address}/authenticate`)
        .send({ nonce, signature })
        .expect(401);

      expect(res.body).toHaveProperty(
        "error.message",
        expect.stringContaining("address mismatch")
      );
    });

    it("should return access and refresh tokens for valid signature", async () => {
      const nonce = await authApp.ethereumStorer.getNonce({ address });
      const signature = createSignature({ privateKey, nonce });

      const res = await request(authApp.app)
        .post(`/v1/ethereum/${address}/authenticate`)
        .send({ nonce, signature })
        .expect(200);

      expect(res.body).toHaveProperty("status", "success");
      const { accessToken: token, refreshToken } = res.body.data;
      await expect(authApp.authService.verifyToken({ token })).resolves.toHaveProperty("uid", address);
      const accessToken = await authApp.authService.generateAccessToken({ refreshToken });
      await expect(authApp.authService.verifyToken({ token: accessToken })).resolves.toHaveProperty("uid", address);
    });

    it("should return access and refresh tokens for non 0x prefixed signature", async () => {
      const nonce = await authApp.ethereumStorer.getNonce({ address });
      const signature = stripHexPrefix(createSignature({ privateKey, nonce }));

      const res = await request(authApp.app)
        .post(`/v1/ethereum/${address}/authenticate`)
        .send({ nonce, signature })
        .expect(200);

      expect(res.body).toHaveProperty("status", "success");
      const { accessToken: token, refreshToken } = res.body.data;
      await expect(authApp.authService.verifyToken({ token })).resolves.toHaveProperty("uid", address);
      const accessToken = await authApp.authService.generateAccessToken({ refreshToken });
      await expect(authApp.authService.verifyToken({ token: accessToken })).resolves.toHaveProperty("uid", address);
    });

    it("should return access and refresh tokens for valid signature for uppercase address", async () => {
      const nonce = await authApp.ethereumStorer.getNonce({ address });
      const signature = createSignature({ privateKey, nonce });

      const res = await request(authApp.app)
        .post(`/v1/ethereum/${address.toUpperCase()}/authenticate`)
        .send({ nonce, signature })
        .expect(200);

      expect(res.body).toHaveProperty("status", "success");
      const { accessToken: token, refreshToken } = res.body.data;
      await expect(authApp.authService.verifyToken({ token })).resolves.toHaveProperty("uid", address);
      const accessToken = await authApp.authService.generateAccessToken({ refreshToken });
      await expect(authApp.authService.verifyToken({ token: accessToken })).resolves.toHaveProperty("uid", address);
    });

    it("should return access and refresh tokens for valid signature for uppercase signature", async () => {
      const nonce = await authApp.ethereumStorer.getNonce({ address });
      const signature = addHexPrefix(stripHexPrefix(createSignature({ privateKey, nonce })).toUpperCase());

      const res = await request(authApp.app)
        .post(`/v1/ethereum/${address}/authenticate`)
        .send({ nonce, signature })
        .expect(200);

      expect(res.body).toHaveProperty("status", "success");
      const { accessToken: token, refreshToken } = res.body.data;
      await expect(authApp.authService.verifyToken({ token })).resolves.toHaveProperty("uid", address);
      const accessToken = await authApp.authService.generateAccessToken({ refreshToken });
      await expect(authApp.authService.verifyToken({ token: accessToken })).resolves.toHaveProperty("uid", address);
    });

    it("should return access and refresh tokens for valid signature for uppercase, non 0x prefixed signature", async () => {
      const nonce = await authApp.ethereumStorer.getNonce({ address });
      const signature = stripHexPrefix(createSignature({ privateKey, nonce })).toUpperCase();

      const res = await request(authApp.app)
        .post(`/v1/ethereum/${address}/authenticate`)
        .send({ nonce, signature })
        .expect(200);

      expect(res.body).toHaveProperty("status", "success");
      const { accessToken: token, refreshToken } = res.body.data;
      await expect(authApp.authService.verifyToken({ token })).resolves.toHaveProperty("uid", address);
      const accessToken = await authApp.authService.generateAccessToken({ refreshToken });
      await expect(authApp.authService.verifyToken({ token: accessToken })).resolves.toHaveProperty("uid", address);
    });
  });
});
