// SPDX-License-Identifier: MIT
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { isNonEmptyString } from "../util.js";
import { HttpError } from "../errors/http.js";

export const parseAuthTokenFromRequest = (req: Request): string | null => {
  const queryAuthToken = (req.query as any)?.access_token;
  if (isNonEmptyString(queryAuthToken)) return queryAuthToken;
  const bodyAuthToken = (req.body as any)?.auth;
  if (isNonEmptyString(bodyAuthToken)) return bodyAuthToken;
  let headerAuthToken = req.get("Authorization");
  if (isNonEmptyString(headerAuthToken)) {
    if (headerAuthToken.startsWith("Bearer ")) {
      headerAuthToken = headerAuthToken.slice("Bearer ".length);
    }
    return headerAuthToken;
  }
  return null;
};

export const createError = (code: number, message: string) => ({ code, message });
export const createErrorResponse = (error: unknown) => ({ status: "error", error });

const handleError = (err: any, res: Response, next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.statusCode).json(createErrorResponse(createError(err.code, err.message)));
  } else {
    next(err);
  }
};

export const buildHttpHandler =
  (handler: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler =>
  async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      handleError(err, res, next);
    }
  };

export const optionsHandler = buildHttpHandler(async (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Request-Methods", "POST, GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "X-PINGOTHER, Content-Type");
  res.set("Connection", "Keep-Alive");
  res.sendStatus(204);
});
