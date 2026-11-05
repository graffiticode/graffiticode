import { buildModelCache, modelCacheKey, parseModelCacheConfig } from "./model-cache.js";

describe("model-cache.js", () => {
  it("keys a model by everything that decides it", () => {
    const base = { lang: "0184", code: { root: 1 }, options: {}, baseUrl: "https://l0184.example", generation: "interp-1" };
    const key = modelCacheKey(base);
    expect(modelCacheKey({ ...base })).toBe(key);
    for (const change of [{ lang: "0186" }, { code: { root: 2 } }, { options: { o: 1 } }, { baseUrl: "https://pinned" }, { generation: "interp-2" }]) {
      expect(modelCacheKey({ ...base, ...change })).not.toBe(key);
    }
  });

  it("forgets an entry after its TTL, and the oldest past its size", () => {
    let t = 0;
    const cache = buildModelCache({ ttlMs: 100, max: 2, now: () => t });
    cache.put("a", { revision: "r1" });
    expect(cache.get("a")).toEqual({ revision: "r1" });
    t = 101;
    expect(cache.get("a")).toBeNull();
    cache.put("a", 1);
    cache.put("b", 2);
    cache.put("c", 3);
    expect([cache.get("a"), cache.get("b"), cache.get("c")]).toEqual([null, 2, 3]);
    cache.drop("b");
    expect(cache.get("b")).toBeNull();
  });

  it("reads its settings from the environment; a TTL of 0 turns it off", () => {
    expect(parseModelCacheConfig({})).toEqual({ enabled: true, ttlMs: 600000, max: 5000 });
    expect(parseModelCacheConfig({ MODEL_CACHE_TTL_MS: "0" }).enabled).toBe(false);
    expect(() => parseModelCacheConfig({ MODEL_CACHE_TTL_MS: "-1" })).toThrow();
    expect(() => parseModelCacheConfig({ MODEL_CACHE_MAX: "0" })).toThrow();
  });
});
