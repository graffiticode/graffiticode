// SPDX-License-Identifier: MIT
export class HttpError extends Error {
  code: number;
  statusCode: number;
  constructor({ code = 500, statusCode = code, message }: { code?: number; statusCode?: number; message?: string }) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class NotFoundError extends HttpError {
  constructor(message?: string) {
    super({ code: 404, message });
  }
}

export class InvalidArgumentError extends HttpError {
  constructor(message?: string) {
    super({ code: 400, message });
  }
}

export class UnauthenticatedError extends HttpError {
  constructor(message?: string) {
    super({ code: 401, message });
  }
}
