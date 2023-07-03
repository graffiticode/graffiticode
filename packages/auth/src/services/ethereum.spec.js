import { privateToAddress } from "@ethereumjs/util";
import { InvalidArgumentError, UnauthenticatedError } from "@graffiticode/common/errors";
import { NonceMismatchError } from "../errors/ethereum.js";
import { buildEthereumStorer } from "../storage/ethereum.js";
import { cleanUpFirebase } from "../testing/firebase.js";
import { buildEthereumService, createSignature } from "./ethereum.js";

describe("authenticators/ethereum", () => {
  const privateKey = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex");
  const address = privateToAddress(privateKey).toString("hex");

  let ethereumService;
  beforeEach(() => {
    ethereumService = buildEthereumService({ ethereumStorer: buildEthereumStorer() });
  });

  afterEach(async () => {
    await cleanUpFirebase();
  });

  it("should authenticate valid signature", async () => {
    const nonce = await ethereumService.getNonce({ address });
    const signature = createSignature({ privateKey, nonce });

    const { uid } = await ethereumService.authenticate({ address, nonce, signature });

    expect(uid).toBe(address);
  });

  it("should throw NonceMismatchError is nonces do not match", async () => {
    const nonce = await ethereumService.getNonce({ address });
    const signature = createSignature({ privateKey, nonce });

    await expect(ethereumService.authenticate({ address, nonce: "deadbeef", signature }))
      .rejects.toThrow(NonceMismatchError);
  });

  it("should throw InvalidArgumentError if invalid signature", async () => {
    const nonce = await ethereumService.getNonce({ address });
    const signature = "0xdeadbeef";

    await expect(ethereumService.authenticate({ address, nonce, signature }))
      .rejects.toThrow(InvalidArgumentError);
  });

  it("should throw UnauthenticatedError is signature addreses do not match", async () => {
    const nonce = await ethereumService.getNonce({ address });
    const signature = createSignature({ privateKey, nonce: "deadbeef" });

    await expect(ethereumService.authenticate({ address, nonce, signature }))
      .rejects.toThrow(UnauthenticatedError);
  });
});
