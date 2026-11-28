// Each request's id, for correlation (error handling proposal, step 2: the
// "request reference"). Moved here from Policy's audit module, which
// re-exports it, so any service can read it without depending on Policy.
// One request's work runs within its context (requestContextMiddleware), so
// an audit record or a public error made within it carries the same id.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const requestContext = new AsyncLocalStorage<{ requestId: string }>();
export const requestContextMiddleware = (_req: unknown, _res: unknown, next: () => void) => requestContext.run({ requestId: randomUUID() }, next);
export const currentRequestId = (): string | undefined => requestContext.getStore()?.requestId;
