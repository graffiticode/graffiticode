// SPDX-License-Identifier: MIT
import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Form } from "./Form";

const render = (data: any, errors: any[] = []) =>
  renderToStaticMarkup(<Form state={{ data, errors, apply: () => {} }} />);

const options = {
  data: {},
  words: { "\\alpha": "\\alpha" },
  types: {},
  rules: { "?+?": ["%1 + %2"], "?": ["%1"] },
};

describe("Form", () => {
  test("compile errors are shown instead of results", () => {
    const html = render({}, [{ message: "Unknown word: rulez" }]);
    expect(html).toContain("Unknown word: rulez");
    expect(html).not.toContain("No tests");
  });

  test("an empty corpus says how to add one, and still sizes the rule set", () => {
    const html = render({ options, tests: [] });
    expect(html).toContain("No tests");
    expect(html).toContain("1 word · 0 types · 2 rules");
  });

  test("each case is a row with its status, and the tally counts them", () => {
    const html = render({
      options,
      tests: [
        { score: 1, source: "1+2", actual: "1 + 2", expected: "1 + 2" },
        { score: -1, source: "1+2", actual: "1 + 2", expected: "wrong" },
        { score: -1, source: "x+y", actual: "x + y", expected: "" },
      ],
    });
    expect(html).toContain("1 passed · 1 failed · 1 captured");
    const body = html.slice(html.indexOf("<tbody>"));
    expect(body.match(/<tr /g)).toHaveLength(3);
    expect(html).toContain(">wrong<");
  });

  // Translations are text: a backslash an author is checking for must come through verbatim.
  test("LaTeX is shown verbatim, not typeset", () => {
    const html = render({
      options,
      tests: [{ score: 1, source: "\\alpha", actual: "\\alpha", expected: "\\alpha" }],
    });
    expect(html).toContain("\\alpha");
  });

  test("an empty translation is made visible", () => {
    const html = render({ options, tests: [{ score: -1, source: "?", actual: "", expected: "x" }] });
    expect(html).toContain("(empty)");
  });
});
