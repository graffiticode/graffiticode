import { InvalidArgumentError } from "@graffiticode/common/src/errors.js";

export class NonceMismatchError extends InvalidArgumentError {
  constructor() {
    super("nonce does not match");
  }
}
