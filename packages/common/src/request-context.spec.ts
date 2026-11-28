import { currentRequestId, requestContextMiddleware } from "./request-context.js";

describe("request context", () => {
  it("gives each request its own id, and none outside a request", async () => {
    const ids: (string | undefined)[] = [];
    const run = () => new Promise<void>(resolve => requestContextMiddleware({}, {}, () => {
      // Across an await, still the same request.
      Promise.resolve().then(() => {
        ids.push(currentRequestId());
        resolve();
      });
    }));
    await run();
    await run();
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[0]).not.toBe(ids[1]);
    expect(currentRequestId()).toBeUndefined();
  });
});
