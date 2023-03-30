import { ETHEREUM_NONCE_MISMATCH } from "./codes.js";
import { HttpError } from "./http.js";

export class NonceMismatchError extends HttpError {
  constructor() {
    super({ code: ETHEREUM_NONCE_MISMATCH, statusCode: 400, message: "nonce does not match" });
  }
}
