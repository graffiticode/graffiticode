// Reading another service's refusal (error handling proposal, step 1, PR 1c).
// A refusal's body is read as a stream and abandoned past `limit` bytes, so an
// oversized answer never costs more than the limit, and a stalled one ends with
// the caller's deadline (its AbortSignal aborts the read). Only the parsed
// fields below leave this module: the body itself is never kept, attached to
// an error, or logged.
import { categoryForStatus, classify } from "@graffiticode/common/failures";

export const REFUSAL_BODY_LIMIT = 64 * 1024;

// What a log line may say of a reason another service sent: the reason when
// it is registered (common/failures), otherwise a fixed marker. An unknown
// reason is the sender's text, and the logs carry no body text.
export const UNREGISTERED_MARKER = "unregistered-reason";
export const loggableReason = reason => {
  if (reason === null || reason === undefined) return null;
  return typeof reason === "string" && classify(reason).classified ? reason : UNREGISTERED_MARKER;
};
const MESSAGE_LIMIT = 500;

// At most `limit` bytes of `res`'s body, as text: { text, bytesRead, truncated }.
export const readBoundedText = async (res, { limit = REFUSAL_BODY_LIMIT } = {}) => {
  if (!res?.body) return { text: "", bytesRead: 0, truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let bytesRead = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = limit - bytesRead;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        bytesRead = limit;
        truncated = true;
        break;
      }
      chunks.push(value);
      bytesRead += value.byteLength;
    }
  } finally {
    // Past the limit, the rest is never read: cancelling closes the connection.
    if (truncated) await reader.cancel().catch(() => {});
    else reader.releaseLock();
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytesRead, truncated };
};

// A refusal's public fields: { status, reason, category, message, bytesRead,
// truncated }. `reason` is the body's `error.reason`, or its `error.code` when
// that is a string (a language names its reason either way), or null. The
// category is decided here, once: the reason's, or with none the status's
// (categoryForStatus), so a body-less 401 is `authentication`, a 400
// `malformed` and a 429 `unavailable`. A truncated or unparseable body counts
// as none. `message` is the body's own message, capped.
export const readRefusal = async (res, options = {}) => {
  const { text, bytesRead, truncated } = await readBoundedText(res, options);
  let json = null;
  if (!truncated && text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  const error = json && typeof json === "object" ? json.error : undefined;
  const reason = typeof error?.reason === "string" && error.reason
    ? error.reason
    : typeof error?.code === "string" && error.code ? error.code : null;
  const rawMessage = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : null;
  return {
    status: res.status,
    reason,
    category: reason ? classify(reason).category : categoryForStatus(res.status),
    message: rawMessage ? rawMessage.slice(0, MESSAGE_LIMIT) : null,
    bytesRead,
    truncated,
  };
};
