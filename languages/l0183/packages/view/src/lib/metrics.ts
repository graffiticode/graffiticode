// SPDX-License-Identifier: MIT
/**
 * How much room each edge label needs. Pure, tested without a DOM.
 *
 * A label's room is reserved for everything that could ever sit in it: an authored label is
 * one candidate; a blank line label is every item of the edges tray (answers and distractors
 * alike, since the learner can drop any of them there) plus the empty placeholder. Width and
 * height are reserved separately, each the largest across the candidates, so placing an answer
 * never changes the layout.
 *
 * The real sizes are measured in the DOM (Web.tsx renders every candidate offscreen with the
 * same LabelFace). Until they are, `estimate` stands in.
 */
import { isImageUrl } from "./text-kind";

export interface Size {
  w: number;
  h: number;
}

/** A label's box. The face renders exactly these, so a measurement is a true bound. */
export const LABEL = {
  font: 12,
  line: 16,
  padX: 10,
  padY: 4,
  border: 2,
  maxW: 180,
  maxH: 72,
  imgW: 64,
  imgH: 40,
  blankMinW: 64,
} as const;

/** The content box inside a label's padding and border. */
export const LABEL_CONTENT = {
  w: LABEL.maxW - 2 * (LABEL.padX + LABEL.border),
  h: LABEL.maxH - 2 * (LABEL.padY + LABEL.border),
};

export type CandidateKind = "label" | "blank";

export interface Candidate {
  kind: CandidateKind;
  /** null is the empty blank's placeholder. */
  text: string | null;
}

export function candidateKey(c: Candidate): string {
  return `${c.kind}\u0001${c.text ?? "\u0000"}`;
}

/** A character-count estimate of a candidate's box, used before it has been measured. */
export function estimate(c: Candidate): Size {
  const chrome = { w: 2 * (LABEL.padX + LABEL.border), h: 2 * (LABEL.padY + LABEL.border) };
  let content: Size;
  if (c.text === null) {
    content = { w: LABEL.font, h: LABEL.line };
  } else if (isImageUrl(c.text)) {
    content = { w: LABEL.imgW, h: LABEL.imgH };
  } else {
    const plain = c.text.replace(/\$/g, "");
    const width = plain.length * LABEL.font * 0.55;
    const lines = Math.max(1, Math.ceil(width / LABEL_CONTENT.w));
    content = { w: Math.min(width, LABEL_CONTENT.w), h: Math.min(lines * LABEL.line, LABEL_CONTENT.h) };
  }
  let w = Math.ceil(content.w + chrome.w);
  if (c.kind === "blank") w = Math.max(w, LABEL.blankMinW);
  return { w, h: Math.ceil(content.h + chrome.h) };
}

/** The room to reserve: the widest and the tallest candidate, taken separately. */
export function reserve(candidates: Candidate[], measured: Record<string, Size>): Size {
  let w = 0;
  let h = 0;
  for (const c of candidates) {
    const s = measured[candidateKey(c)] ?? estimate(c);
    w = Math.max(w, s.w);
    h = Math.max(h, s.h);
  }
  return { w, h };
}

/** Every candidate for one edge. */
export function edgeCandidates(
  edge: { label?: string; blank?: boolean },
  trayTexts: string[],
): Candidate[] {
  if (edge.blank) {
    return [{ kind: "blank", text: null }, ...trayTexts.map((text) => ({ kind: "blank" as const, text }))];
  }
  return edge.label ? [{ kind: "label", text: edge.label }] : [];
}
