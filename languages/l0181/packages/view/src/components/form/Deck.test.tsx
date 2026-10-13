// SPDX-License-Identifier: MIT
/**
 * The study loop, driven the way a learner drives it.
 *
 * The Deck is CONTROLLED: it reports study state and renders whatever it is given back. So
 * these render it, click, and assert on what it reported — which is also the contract the
 * compile envelope carries.
 */
import { test, describe, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Deck } from "./Deck";
import type { Card, Study } from "./Deck";

const CARDS: Card[] = [
  { id: 0, front: "hola", back: "hello" },
  { id: 1, front: "adiós", back: "goodbye" },
  { id: 2, front: "agua", back: "water" },
];

/** Render the deck, and let the test re-render it with whatever it last reported. */
function open(study: Study = {}) {
  const onStudy = vi.fn();
  const view = render(<Deck cards={CARDS} study={study} onStudy={onStudy} />);
  const rerenderWithLast = () =>
    view.rerender(<Deck cards={CARDS} study={onStudy.mock.lastCall![0]} onStudy={onStudy} />);
  return { onStudy, rerenderWithLast, ...view };
}

/** The card face currently on screen. */
function face(): string {
  return (
    screen.getByRole("button", { name: /Reveal the answer|Show the front/ }).textContent ?? ""
  ).trim();
}

describe("flipping", () => {
  test("opens on a front", () => {
    open();
    expect(CARDS.map((c) => c.front)).toContain(face());
  });

  test("clicking the card reveals its back, and again returns to the front", () => {
    open({ cardId: 0 });
    expect(face()).toBe("hola");
    fireEvent.click(screen.getByRole("button", { name: "Reveal the answer" }));
    expect(face()).toBe("hello");
    fireEvent.click(screen.getByRole("button", { name: "Show the front" }));
    expect(face()).toBe("hola");
  });

  test("the Reveal button does the same thing", () => {
    open({ cardId: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(face()).toBe("hello");
  });

  test("the card is reachable from the keyboard", () => {
    open({ cardId: 0 });
    fireEvent.keyDown(screen.getByRole("button", { name: "Reveal the answer" }), { key: "Enter" });
    expect(face()).toBe("hello");
  });

  test("rating buttons appear only once the answer is showing", () => {
    open({ cardId: 0 });
    expect(screen.queryByRole("button", { name: "I got this!" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(screen.getByRole("button", { name: "I got this!" })).toBeTruthy();
  });
});

describe("rating", () => {
  test("reports the rating against the card's id", () => {
    const { onStudy } = open({ cardId: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    fireEvent.click(screen.getByRole("button", { name: "I got this!" }));
    expect(onStudy).toHaveBeenCalledTimes(1);
    expect(onStudy.mock.lastCall![0].marks).toEqual({ "1": "known" });
  });

  test("keeps earlier ratings", () => {
    const { onStudy } = open({ cardId: 1, marks: { "0": "practice" } });
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    fireEvent.click(screen.getByRole("button", { name: "I need more practice" }));
    expect(onStudy.mock.lastCall![0].marks).toEqual({ "0": "practice", "1": "practice" });
  });

  test("advances to another card, and stops showing the answer", () => {
    const { onStudy, rerenderWithLast } = open({ cardId: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    fireEvent.click(screen.getByRole("button", { name: "I got this!" }));
    expect(onStudy.mock.lastCall![0].cardId).not.toBe(1);
    rerenderWithLast();
    expect(screen.getByRole("button", { name: "Reveal" })).toBeTruthy();
  });

  test("rating the last card of a stack empties it rather than stranding the learner", () => {
    // Studying "Not yet rated" with one card left: rating it leaves the stack with nothing in
    // it, and the deck must say so instead of showing a card that is no longer in the stack.
    const { onStudy, rerenderWithLast } = open({
      stack: "unmarked",
      marks: { "0": "known", "2": "known" },
      cardId: 1,
    });
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    fireEvent.click(screen.getByRole("button", { name: "I got this!" }));
    expect(onStudy.mock.lastCall![0].cardId).toBeNull();
    rerenderWithLast();
    expect(screen.getByText("Nothing in this stack")).toBeTruthy();
  });
});

describe("navigation", () => {
  // L0159 wrote Next and Back and then commented them out, so rating was the only way to
  // move — a learner who wanted to skip a card had to claim they knew it.
  test("Next moves without recording a rating", () => {
    const { onStudy } = open({ cardId: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Next card" }));
    expect(onStudy.mock.lastCall![0].cardId).not.toBe(0);
    expect(onStudy.mock.lastCall![0].marks).toEqual({});
  });

  test("Back undoes Next", () => {
    const { onStudy, rerenderWithLast } = open({ cardId: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Next card" }));
    rerenderWithLast();
    fireEvent.click(screen.getByRole("button", { name: "Previous card" }));
    expect(onStudy.mock.lastCall![0].cardId).toBe(0);
  });

  test("moving on hides an answer that was showing", () => {
    const { rerenderWithLast } = open({ cardId: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    fireEvent.click(screen.getByRole("button", { name: "Next card" }));
    rerenderWithLast();
    expect(screen.getByRole("button", { name: "Reveal" })).toBeTruthy();
  });

  test("Next wraps at the end of the deck", () => {
    const { onStudy, rerenderWithLast } = open({ cardId: 0 });
    const seen = new Set<number>();
    for (let i = 0; i < CARDS.length; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Next card" }));
      seen.add(onStudy.mock.lastCall![0].cardId);
      rerenderWithLast();
    }
    expect(seen.size).toBe(CARDS.length);
    expect(seen.has(0)).toBe(true);
  });
});

describe("stacks", () => {
  test("the picker counts each stack", () => {
    open({ marks: { "0": "known", "1": "practice" } });
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual([
      "All cards (3)",
      "Not yet rated (1)",
      "Need more practice (1)",
      "Got these (1)",
    ]);
  });

  test("choosing a stack jumps into it", () => {
    const { onStudy } = open({ marks: { "2": "practice" }, cardId: 0 });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "practice" } });
    expect(onStudy.mock.lastCall![0]).toMatchObject({ stack: "practice", cardId: 2 });
  });

  test("an empty stack says so", () => {
    open({ stack: "known" });
    expect(screen.getByText("Nothing in this stack")).toBeTruthy();
  });

  test("progress counts within the stack, not the deck", () => {
    open({ stack: "practice", marks: { "0": "practice", "2": "practice" }, cardId: 2 });
    expect(screen.getByText(/\d+ \/ \d+/).textContent).toMatch(/^[12] \/ 2$/);
  });
});

describe("an image card fits the card", () => {
  // `max-h-full` on the image is a percentage against its parent. A percentage max-height
  // resolves to `none` when the parent's height is indefinite, so the constraint that keeps a
  // tall image inside the card only exists if this wrapper is sized against the card's own
  // definite `h-64`. It is the wrapper, not the image, that regresses.
  const IMAGE: Card[] = [{ id: 0, front: "https://example.com/jp.png", back: "Japan" }];

  function wrapper(): HTMLElement {
    const card = screen.getByRole("button", { name: /Reveal the answer|Show the front/ });
    return card.firstElementChild as HTMLElement;
  }

  test("the content wrapper fills the card in both directions", () => {
    render(<Deck cards={IMAGE} study={{}} onStudy={vi.fn()} />);
    const cls = wrapper().className.split(/\s+/);
    expect(cls).toContain("h-full");
    expect(cls).toContain("w-full");
  });

  test("the wrapper may shrink below its content's intrinsic width", () => {
    // A flex item's automatic minimum size is its content's; for an image that is the image's
    // intrinsic width, so a wide one pushes the wrapper past the card without this.
    render(<Deck cards={IMAGE} study={{}} onStudy={vi.fn()} />);
    expect(wrapper().className.split(/\s+/)).toContain("min-w-0");
  });

  test("the image is inside that wrapper, bounded on both axes", () => {
    render(<Deck cards={IMAGE} study={{}} onStudy={vi.fn()} />);
    const img = screen.getByAltText("https://example.com/jp.png");
    expect(wrapper().contains(img)).toBe(true);
    const cls = img.className.split(/\s+/);
    expect(cls).toContain("max-h-full");
    expect(cls).toContain("max-w-full");
    expect(cls).toContain("object-contain");
  });
});
