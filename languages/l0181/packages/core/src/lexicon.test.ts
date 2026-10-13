// SPDX-License-Identifier: MIT
/**
 * The lexicon merge.
 *
 * `mergeLexicon` throws at IMPORT time if a child word shadows a base word without being
 * declared an override, so importing the module at all is most of the test. The rest pins the
 * shape the console and the code generator read out of lexicon.json.
 */
import { test, describe, expect } from "vitest";
import { lexicon as base } from "@graffiticode/l0000";
import { lexicon } from "./lexicon.js";

const OWN = ["cards", "title", "instructions", "theme", "DARK", "LIGHT"];

describe("lexicon", () => {
  test("carries every base word through", () => {
    for (const word of Object.keys(base)) {
      expect(lexicon[word]).toEqual(base[word]);
    }
  });

  test("adds L0181's words and nothing else", () => {
    const added = Object.keys(lexicon).filter((w) => !(w in base));
    expect(added.sort()).toEqual([...OWN].sort());
  });

  test("shadows no base word", () => {
    for (const word of OWN) {
      expect(word in base).toBe(false);
    }
  });

  test("every L0181 word is arity 2 and takes a record", () => {
    for (const word of ["cards", "title", "instructions", "theme"]) {
      expect(lexicon[word].arity).toBe(2);
      expect(lexicon[word].type).toMatch(/record: record>$/);
    }
  });

  test("every entry is documented — the console shows these", () => {
    for (const word of OWN) {
      expect(lexicon[word].description, word).toBeTruthy();
      expect(lexicon[word].type, word).toBeTruthy();
    }
  });

  test("DARK and LIGHT are tag values, not functions", () => {
    for (const t of ["DARK", "LIGHT"]) {
      expect(lexicon[t].cls).toBe("val");
      expect(lexicon[t].name).toBe("TAG");
      expect(lexicon[t].arity).toBe(0);
    }
  });
});
