import cors from "cors";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import morgan from "morgan";
import {
  ConflictError,
  DeadlineExceededError,
  InvalidArgumentError,
  NotFoundError,
  NotImplementedError,
  ResourceExhaustedError,
  UnauthenticatedError,
  UnauthorizedError,
  UnavailableError
} from "./errors.js";
import { isNonEmptyString } from "./utils.js";
import { categoryForStatus, isMalformedBody } from "./failures.js";
import type { FailureCategory } from "./failures.js";

export type ErrorBody = { code: number; message: string; details?: unknown; category?: FailureCategory };

export const createError = (code: number, message: string, details?: unknown): ErrorBody => {
  const err: ErrorBody = { code, message };
  if (details !== undefined) err.details = details;
  return err;
};

// Every error body carries its failure category (failures.js, spec FAIL-01).
// The status is unchanged; a body the JSON parser rejected is the caller's
// malformed request whatever its status.
const categorized = (body: ErrorBody, err: unknown): ErrorBody =>
  ({ ...body, category: isMalformedBody(err) ? "malformed" : categoryForStatus(body.code) });

export const createErrorResponse = (error: ErrorBody) => ({ status: "error", error, data: null });

export const createSuccessResponse = (data: unknown) => ({ status: "success", error: null, data });

export const sendSuccessResponse = (res: Response, data: unknown) => res.status(200).json(createSuccessResponse(data));

export const translateError = (err: Error & { details?: unknown }): ErrorBody => {
  if (err instanceof ConflictError) {
    return createError(409, err.message, err.details);
  }
  if (err instanceof DeadlineExceededError) {
    return createError(504, err.message);
  }
  if (err instanceof InvalidArgumentError) {
    return createError(400, err.message);
  }
  if (err instanceof NotFoundError) {
    return createError(404, err.message);
  }
  if (err instanceof NotImplementedError) {
    return createError(501, err.message);
  }
  if (err instanceof ResourceExhaustedError) {
    return createError(429, err.message);
  }
  if (err instanceof UnauthenticatedError) {
    return createError(401, err.message);
  }
  if (err instanceof UnauthorizedError) {
    return createError(403, err.message);
  }
  if (err instanceof UnavailableError) {
    return createError(503, err.message);
  }
  return createError(500, err.message);
};

const handleError = (err: Error, res: Response): void => {
  const error = categorized(translateError(err), err);
  res.status(error.code).json(createErrorResponse(error));
};

// Handlers see the request as `any`: services attach their own fields (req.auth).
export const buildHttpHandler = (handler: (req: any, res: any, next: NextFunction) => unknown) => async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await handler(req, res, next);
  } catch (err) {
    next(err);
  }
};

export const errorHandler = (err: Error, req: Request, res: Response, next: NextFunction): void => {
  if (res.headersSent) {
    console.error(err);
  } else {
    handleError(err, res);
  }
};

export const createHttpApp = (addRoutesFn: (app: Express) => void): Express => {
  const app = express();

  if (process.env.NODE_ENV === "production") {
    app.use(morgan("combined"));
  } else {
    app.use(morgan("dev"));
  }
  app.use(cors());
  app.use(express.json({ limit: "50mb" }));

  // Add Routes
  addRoutesFn(app);
  app.get("/", (req, res) => res.sendStatus(200));

  // Handle errors
  app.use(errorHandler);

  return app;
};

export const parseTokenFromRequest = (req: Request): string | null => {
  const { access_token: queryAccessToken } = req.query;
  if (isNonEmptyString(queryAccessToken)) {
    return queryAccessToken;
  }
  let headerAuthToken = req.get("Authorization");
  if (isNonEmptyString(headerAuthToken)) {
    if (headerAuthToken.startsWith("Bearer ")) {
      headerAuthToken = headerAuthToken.slice("Bearer ".length);
    }
    return headerAuthToken;
  }
  return null;
};
