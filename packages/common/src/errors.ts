export class ConflictError extends Error {
  // Type-only (declare): an ES2022 class field would initialize at runtime.
  // `any` keeps callers that read e.g. details.conflictUid as they were;
  // phase 4 narrows it.
  declare details: any;
  constructor(message?: string, details?: any) {
    super(message);
    this.details = details;
  }
}

export class DeadlineExceededError extends Error { }

export class IllegalStateError extends Error { }

export class InvalidArgumentError extends Error { }

export class NotFoundError extends Error { }

export class NotImplementedError extends Error { }

export class ResourceExhaustedError extends Error { }

export class UnauthenticatedError extends Error { }

export class UnauthorizedError extends Error { }

export class UnavailableError extends Error { }

export const error = (ErrorClass: new (...args: any[]) => Error, args: unknown[]): Error => new (ErrorClass)(...args);
export const assert = (condition: unknown, error: Error): void => {
  if (!condition) {
    throw error;
  }
};

export const checkArgument = (condition: unknown, ...args: unknown[]): void => assert(condition, error(InvalidArgumentError, args));

export const checkState = (condition: unknown, ...args: unknown[]): void => assert(condition, error(IllegalStateError, args));
