// SPDX-License-Identifier: MIT
/**
 * Telling prose, math and images apart.
 *
 * L0159 ran every card through KaTeX in display mode, so an English definition rendered as
 * italic math with the spacing collapsed. These pin the boundary that replaced it.
 */
import { test, describe, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CardText, isImageUrl, segments, textSize } from "./text";

describe("segments", () => {
  test("plain prose is one non-math run", () => {
    expect(segments("plants convert light to energy")).toEqual([
      { math: false, text: "plants convert light to energy" },
    ]);
  });

  test("a $...$ span is math and the delimiters are dropped", () => {
    expect(segments("$x^2$")).toEqual([{ math: true, text: "x^2" }]);
  });

  test("math inside prose splits into runs", () => {
    expect(segments("The derivative of $x^2$ is $2x$")).toEqual([
      { math: false, text: "The derivative of " },
      { math: true, text: "x^2" },
      { math: false, text: " is " },
      { math: true, text: "2x" },
    ]);
  });

  test("a lone dollar sign is a dollar sign, not an opening delimiter", () => {
    // A currency deck must not turn into math from its first $ to the end of the card.
    expect(segments("costs $5 or more")).toEqual([{ math: false, text: "costs $5 or more" }]);
  });
});

describe("isImageUrl", () => {
  test("a bare URL is an image", () => {
    expect(isImageUrl("https://example.com/dog.png")).toBe(true);
    expect(isImageUrl("  http://example.com/a.jpg  ")).toBe(true);
    expect(isImageUrl("data:image/png;base64,AAAA")).toBe(true);
  });

  test("prose mentioning a URL is not", () => {
    expect(isImageUrl("see https://example.com for more")).toBe(false);
    expect(isImageUrl("photosynthesis")).toBe(false);
  });
});

describe("CardText", () => {
  test("prose renders as text, not as math", () => {
    const { container } = render(<CardText text="plants convert light" />);
    expect(container.textContent).toBe("plants convert light");
    expect(container.querySelector(".katex")).toBeNull();
  });

  test("a math span is typeset", () => {
    const { container } = render(<CardText text="$x^2$" />);
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  test("prose around math stays prose", () => {
    const { container } = render(<CardText text="The derivative of $x^2$" />);
    expect(container.textContent).toContain("The derivative of ");
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  test("a URL renders an image, captioned by its alt", () => {
    render(<CardText text="https://example.com/jp.png" alt="Japan" />);
    const img = screen.getByAltText("Japan") as HTMLImageElement;
    expect(img.src).toBe("https://example.com/jp.png");
  });

  test("an image is bounded by the card in both directions", () => {
    // The author's image is whatever size the author's image is. Without both maxima a tall
    // one runs through the card's bottom border and a wide one through its sides; without
    // object-contain, fitting one axis distorts the other. `block` is here because preflight
    // is off, so an image is inline by default and leaves a baseline gap beneath it.
    render(<CardText text="https://example.com/jp.png" alt="Japan" />);
    const img = screen.getByAltText("Japan");
    expect(img.className.split(/\s+/).sort()).toEqual([
      "block",
      "max-h-full",
      "max-w-full",
      "object-contain",
    ]);
  });
});

describe("textSize", () => {
  test("short text is set large", () => {
    expect(textSize("hola")).toBe("text-5xl");
  });

  test("text is set smaller the longer it gets", () => {
    const ladder = [
      textSize("hola"),
      textSize("por favor, mas agua"),
      textSize("process by which plants convert light into energy"),
      textSize(
        "the process by which green plants and some other organisms use sunlight to " +
          "synthesize nutrients from carbon dioxide and water",
      ),
    ];
    expect(ladder).toEqual(["text-5xl", "text-3xl", "text-2xl", "text-xl"]);
  });

  test("math is measured as it renders, not as it is spelled", () => {
    // Fourteen characters of source, three glyphs on the card.
    expect(textSize("$\\frac{1}{2}$")).toBe("text-5xl");
  });
});
