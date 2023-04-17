export class DeadlineExceededError extends Error { }

export class IllegalStateError extends Error { }

export class InvalidArgumentError extends Error { }

export class NotFoundError extends Error { }

export class NotImplementedError extends Error { }

export class ResourceExhaustedError extends Error { }

export class UnauthenticatedError extends Error { }

export class UnauthorizedError extends Error { }

export class UnavailableError extends Error { }

export const error = (errorClass, args) => new (errorClass)(...args);
export const assert = (condition, error) => {
  if (!condition) {
    throw error;
  }
};

export const checkArgument = (condition, ...args) => assert(condition, error(InvalidArgumentError, args));

export const checkState = (condition, ...args) => assert(condition, error(IllegalStateError, args));
