export class HttpError extends Error {
  // `reason`: the refusal reason when the error relays one (e.g. Policy's).
  constructor({ code = 500, statusCode = code, message, reason = undefined }) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.reason = reason;
  }
}

export class NotFoundError extends HttpError {
  constructor(message) {
    super({ code: 404, message });
  }
}

export class InvalidArgumentError extends HttpError {
  constructor(message) {
    super({ code: 400, message });
  }
}

export class DecodeIdError extends HttpError {
  constructor(message) {
    super({ code: 4001, statusCode: 400, message });
  }
}

export class UnauthenticatedError extends HttpError {
  constructor(message) {
    super({ code: 401, message });
  }
}
