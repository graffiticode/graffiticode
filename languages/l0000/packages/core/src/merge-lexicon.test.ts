// Lexicon inheritance is child-over-parent, so a colliding child word deletes the
// base function silently and the symptom shows up somewhere else entirely. These
// tests pin the two real cases the rule was written for: L0174's deliberate
// `min`/`max` override in a forms dialect, and L0177's `filter` collision, which was
// a bug and was fixed by renaming rather than overriding.
import { describe, test, expect } from "vitest";
import { mergeLexicon, lexicon as base } from "@graffiticode/l0000";

const fn = (name, arity) => ({ tk: 1, name, cls: "function", length: arity, arity });

describe("mergeLexicon", () => {
  test("merges child words over the base", () => {
    const out = mergeLexicon(base, { "author-embed": fn("AUTHOR_EMBED", 1) });
    expect(out["author-embed"]).toEqual(fn("AUTHOR_EMBED", 1));
    expect(out.filter).toEqual(base.filter); // base survives untouched
    expect(Object.keys(out).length).toBe(Object.keys(base).length + 1);
  });

  test("an undeclared collision throws, naming the word", () => {
    expect(() => mergeLexicon(base, { filter: fn("FILTER", 1) }))
      .toThrow(/"filter" would shadow/);
  });

  test("the error suggests renaming before overriding", () => {
    // Renaming keeps the base word available; an override spends it permanently.
    expect(() => mergeLexicon(base, { add: fn("ADD", 2) }, { langID: "L0177" }))
      .toThrow(/Rename to avoid the collision \(preferred/);
    expect(() => mergeLexicon(base, { add: fn("ADD", 2) }, { langID: "L0177" }))
      .toThrow(/^L0177 lexicon:/);
  });

  test("a declared override is allowed and replaces the base word", () => {
    // L0174: in a forms dialect min/max are field-range attributes, not math.
    const out = mergeLexicon(
      base,
      { min: fn("MIN", 2), max: fn("MAX", 2) },
      { overrides: ["min", "max"], langID: "L0174" },
    );
    expect(out.min).toEqual(fn("MIN", 2));
    expect(out.min).not.toEqual(base.min);
    expect(Object.keys(out).length).toBe(Object.keys(base).length);
  });

  test("declaring an override that shadows nothing throws", () => {
    // Otherwise a stale entry sits in the list implying a collision that is gone,
    // and the next real collision on that word would pass unnoticed.
    expect(() => mergeLexicon(base, { min: fn("MIN", 2) }, { overrides: ["min", "max"] }))
      .toThrow(/declared override "max" does not shadow anything/);
  });

  test("multiple undeclared collisions are reported together", () => {
    expect(() => mergeLexicon(base, { filter: fn("FILTER", 1), add: fn("ADD", 2) }))
      .toThrow(/"filter", "add"/);
  });

  test("renaming past a collision needs no override", () => {
    // How L0177 actually models config.item_list.filter.restricted / toolbar.add.
    const out = mergeLexicon(base, {
      "filter-restricted": fn("FILTER_RESTRICTED", 1),
      "toolbar-add": fn("TOOLBAR_ADD", 2),
    });
    expect(out.filter).toEqual(base.filter);
    expect(out.add).toEqual(base.add);
    expect(out["filter-restricted"]).toBeDefined();
  });
});
