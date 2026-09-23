// SPDX-License-Identifier: MIT
/**
 * Rendering what an author wrote on a node, a label or a tray item. Taken from L0181.
 *
 * Three kinds of content share one field, so this is where they are told apart:
 *
 *   - a URL renders as an image,
 *   - `$…$` spans render as math,
 *   - everything else is prose.
 *
 * KaTeX sees only what the author delimited as math; prose is never typeset.
 */
import { useEffect, useRef } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

/** A text that is nothing but a URL is an image. */
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
 * A lone `$` is not a delimiter — it is a dollar sign, and a node about prices should not
 * silently become math from the first `$` to the end of the text.
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

/** An image, or prose with its math spans typeset. */
export function RichText({ text, alt = "" }: { text: string; alt?: string }) {
  if (isImageUrl(text)) {
    // `block` because preflight is off, so an image is otherwise inline and sits on the text
    // baseline with a descender's worth of gap under it. `object-contain` letterboxes rather
    // than crops, and the two maxima keep the image inside its node — they only bite because
    // the node has a definite height and width.
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
