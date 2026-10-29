import { compileCacheKey, generationKey, getLanguageGenerations, languageGenerationSuffix } from "./generation.js";

// P2 (docs/graffiticode-interpreter-plan.md): a language's switch generation
// scopes every compile of a chain that contains it.
describe("per-language switch generations", () => {
  it("reads a generation for any language from COMPILE_GENERATION_LNNNN, except L0158's requested one", () => {
    expect(getLanguageGenerations({
      COMPILE_GENERATION_L0184: "rust-1",
      COMPILE_GENERATION_L0000: "g2",
      COMPILE_GENERATION_L0158: "g1",
      COMPILE_GENERATION_L184: "short",
      COMPILE_GENERATION_L0185: "",
      BASE_URL_L0184: "https://l0184r.example",
    })).toEqual({ "0184": "rust-1", "0000": "g2" });
  });

  it("treats a malformed value as unset", () => {
    expect(getLanguageGenerations({ COMPILE_GENERATION_L0184: "a/b", COMPILE_GENERATION_L0183: "x".repeat(129) })).toEqual({});
  });

  it("is inert with nothing set: every key is exactly what it was", () => {
    const tasks = [{ lang: "0184" }, { lang: "0000" }];
    expect(languageGenerationSuffix(tasks, {})).toBe("");
    expect(compileCacheKey({ id: "abc", generation: undefined, tasks, generations: {} })).toBe("abc");
    expect(compileCacheKey({ id: "abc", generation: "g1", tasks, generations: {} })).toBe(generationKey("abc", "g1"));
  });

  it("scopes a chain by every one of its languages that has a generation, in language order, once each", () => {
    const tasks = [{ lang: "L0184" }, { lang: "0000" }, { lang: "0184" }, { lang: "0185" }];
    const generations = { "0184": "rust-1", "0000": "g2", "0176": "other" };
    expect(languageGenerationSuffix(tasks, generations)).toBe("@L0000=g2@L0184=rust-1");
    expect(compileCacheKey({ id: "abc", generation: undefined, tasks, generations })).toBe("abc@L0000=g2@L0184=rust-1");
  });

  it("composes with L0158's requested generation", () => {
    const tasks = [{ lang: "0158" }];
    expect(compileCacheKey({ id: "abc", generation: "g1", tasks, generations: { "0184": "rust-1" } })).toBe("abc@g1");
  });

  it("changes the key when any constituent's generation changes, and only then", () => {
    const tasks = [{ lang: "0184" }, { lang: "0000" }];
    const before = compileCacheKey({ id: "abc", tasks, generations: { "0184": "rust-1" } });
    expect(compileCacheKey({ id: "abc", tasks, generations: { "0184": "rust-2" } })).not.toBe(before);
    expect(compileCacheKey({ id: "abc", tasks, generations: { "0184": "rust-1", "0000": "g1" } })).not.toBe(before);
    expect(compileCacheKey({ id: "abc", tasks, generations: { "0184": "rust-1", "0176": "g1" } })).toBe(before);
  });
});
