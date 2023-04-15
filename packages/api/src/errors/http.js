
export class HttpError extends Error {
  constructor({ code = 500, statusCode = code, message }) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
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
