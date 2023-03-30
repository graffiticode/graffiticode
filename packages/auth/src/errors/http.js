import { USER_ALREADY_EXISTS } from "./codes.js";

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

export class UserExistsError extends HttpError {
  constructor() {
    super({ code: USER_ALREADY_EXISTS, statusCode: 400, message: "user already exists" });
  }
}

export class UnauthenticatedError extends HttpError {
  constructor(message) {
    super({ code: 401, message });
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message) {
    super({ code: 403, message });
  }
}

export class NotImplementedError extends HttpError {
  constructor(message) {
    super({ code: 501, message });
  }
}
