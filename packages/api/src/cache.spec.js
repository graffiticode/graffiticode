import { buildLocalCache } from "./cache.js";

const fakeDelegate = () => {
  const calls = [];
  return {
    calls,
    get: async (...args) => { calls.push(["get", ...args]); return "from-delegate"; },
    set: async (...args) => { calls.push(["set", ...args]); },
    del: async (...args) => { calls.push(["del", ...args]); },
  };
};

describe("cache/buildLocalCache", () => {
  it("stores, reads and deletes locally without a delegate", async () => {
    const cache = buildLocalCache({});
    await cache.set("id", "type", 1);
    await expect(cache.get("id", "type")).resolves.toBe(1);
    await cache.del("id", "type");
    await expect(cache.get("id", "type")).resolves.toBeNull();
  });

  it("writes through to the delegate and falls back to it on a miss", async () => {
    const delegate = fakeDelegate();
    const cache = buildLocalCache({ delegate });
    await cache.set("id", "type", 1);
    await expect(cache.get("id", "type")).resolves.toBe(1);
    await expect(cache.get("other", "type")).resolves.toBe("from-delegate");
    expect(delegate.calls).toEqual([["set", "id", "type", 1], ["get", "other", "type"]]);
  });

  it("deletes from the delegate, rather than writing an empty value", async () => {
    const delegate = fakeDelegate();
    const cache = buildLocalCache({ delegate });
    await cache.del("id", "type");
    expect(delegate.calls).toEqual([["del", "id", "type"]]);
  });
});
