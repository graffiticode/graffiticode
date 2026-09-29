// SPDX-License-Identifier: MIT
/**
 * Rendering what an author wrote on a card.
 *
 * Three kinds of content share one field, so this is where they are told apart:
 *
 *   - a URL renders as an image,
 *   - `$…$` spans render as math,
 *   - everything else is prose.
 *
 * L0159 pushed ALL of it through `katex.render(..., {displayMode: true})`, so an English
 * definition came out as italic math with the spaces collapsed. That is the defect this file
 * exists to not repeat: KaTeX sees only what the author delimited as math.
 */
import { useEffect, useRef } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

/** A card side that is nothing but a URL is an image. */
export function isImageUrl(text: string): boolean {
  return /^https?:\/\/\S+$/.test(text.trim()) || text.trim().startsWith("data:image/");
}

function Math({ latex }: { latex: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) {
      katex.render(latex, ref.current, { displayMode: false, output: "html", throwOnError: false });
    }
  }, [latex]);
  return <span ref={ref} />;
}

/**
 * Split on `$…$`, keeping the delimiters out of the result.
 *
 * A lone `$` is not a delimiter — it is a dollar sign, and a deck of currency vocabulary
 * should not silently become math from the first `$` to the end of the card.
 */
export function segments(text: string): { math: boolean; text: string }[] {
  const out: { math: boolean; text: string }[] = [];
  const re = /\$([^$]+)\$/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ math: false, text: text.slice(last, m.index) });
    out.push({ math: true, text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ math: false, text: text.slice(last) });
  return out.length ? out : [{ math: false, text }];
}

/** One side of a card: an image, or prose with its math spans typeset. */
export function CardText({ text, alt = "" }: { text: string; alt?: string }) {
  if (isImageUrl(text)) {
    // `block` because preflight is off, so an image is otherwise inline and sits on the text
    // baseline with a descender's worth of gap under it. `object-contain` letterboxes rather
    // than crops, and the two maxima are what keep the image inside the card — they only bite
    // because the wrapper in Deck has a definite height and width. Nothing here scales a small
    // image UP: an icon stays an icon rather than being stretched to fill the card.
    return (
      <img src={text.trim()} alt={alt} className="block max-h-full max-w-full object-contain" />
    );
  }
  return (
    <>
      {segments(text).map((seg, i) =>
        seg.math ? <Math key={i} latex={seg.text} /> : <span key={i}>{seg.text}</span>,
      )}
    </>
  );
}

/**
 * How large to set a card's text.
 *
 * Measured on the text as READ, not as written, so `$\frac{1}{2}$` is sized as the three
 * glyphs it renders as rather than the fourteen characters it is spelled with.
 */
export function textSize(text: string): string {
  const visible = segments(text)
    .map((s) => (s.math ? s.text.replace(/\\[a-zA-Z]+|[{}]/g, "") : s.text))
    .join("");
  const len = visible.trim().length;
  if (len <= 12) return "text-5xl";
  if (len <= 32) return "text-3xl";
  if (len <= 80) return "text-2xl";
  return "text-xl";
}
