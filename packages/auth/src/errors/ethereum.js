import { InvalidArgumentError } from "@graffiticode/common/errors";

export class NonceMismatchError extends InvalidArgumentError {
  constructor() {
    super("nonce does not match");
  }
}
