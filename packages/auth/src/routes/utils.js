import { HttpError } from "./../errors/http.js";

export const createError = (code, message) => ({ code, message });

export const createErrorResponse = error => ({ status: "error", error, data: null });

export const createSuccessResponse = data => ({ status: "success", error: null, data });

export const sendSuccessResponse = (res, data) => res.status(200).json(createSuccessResponse(data));

const handleError = (err, res) => {
  if (err instanceof HttpError) {
    res
      .status(err.statusCode)
      .json(createErrorResponse(createError(err.code, err.message)));
  } else {
    console.error(err.stack);
    res.sendStatus(500);
  }
};

export const buildHttpHandler = handler => async (req, res, next) => {
  try {
    await handler(req, res, next);
  } catch (err) {
    // console.error(`${err.stack}`);
    handleError(err, res);
  }
};
