// SPDX-License-Identifier: MIT
/**
 * A mechanical L0180 program for an L0175 item — the reference answer.
 *
 * Two jobs. It is what `compare.test.ts` checks the harness against, so all five types are
 * exercised offline with no generated program and no network; and it is the shape a faithful
 * hand-off produces, so a generated program that scores differently can be read next to one
 * that does not.
 *
 * It is not a translator and must not grow into one — nothing here reads L0175 source, only the
 * neutral `SourceItem` and the passage. Where L0175's model and L0180's differ, the mapping is
 * stated once, here:
 *
 * - Every L0175 item is about a passage, so every port is an `item` with a `stimulus`. That
 *   also puts the response under part ids, which is the shape a two-part item needs anyway.
 * - A part with several correct answers is `response-processing "match-correct"`, because
 *   L0175 scores those as an exact set. One correct answer needs no template: the default sums
 *   a single point.
 * - EBSR is `scoring "conjunctive"`, which is the whole reason the wrapper has that word.
 * - Hot text is a `hottext` part `within "stimulus"`, so the passage renders once with its
 *   sentences clickable.
 * - Short text is an `extended-text` part carrying L0175's rubric bands verbatim.
 */
import { keyOf, type SourceItem, type SourcePart } from "./source.js";

/** GC string literals. Newlines never appear in this content; quotes and backslashes do. */
const s = (v: string): string => `"${String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const stimulus = (compiled: any): string[] => {
  const p = compiled?.passage;
  if (!p?.lines?.length) return [];
  return [
    `  stimulus [`,
    `    title ${s(p.heading)}`,
    `    paragraphs [`,
    ...p.lines.map((l: any) => `      ${s(l.text)}`),
    `    ]`,
    `  ]`,
  ];
};

const choicePart = (part: SourcePart, stem: string): string[] => {
  const correct = keyOf(part).length;
  const lines = [`    choice [`, `      prompt ${s(stem)}`];
  if (part.exactSet) {
    lines.push(
      `      response-processing "match-correct"`,
      `      min-choices ${correct}`,
      `      max-choices ${correct}`,
    );
  }
  lines.push(`      options [`);
  for (const o of part.options) {
    lines.push(`        [ text ${s(o.text)}${o.correct ? " assess [ correct ]" : ""} ]`);
  }
  lines.push(`      ] {}`, `    ]`);
  return lines;
};

const hottextPart = (part: SourcePart, stem: string): string[] => {
  const correct = keyOf(part);
  const lines = [
    `    hottext [`,
    `      prompt ${s(stem)}`,
    `      within "stimulus"`,
    `      granularity "sentence"`,
  ];
  if (correct.length > 1) {
    lines.push(
      `      response-processing "match-correct"`,
      `      min-choices ${correct.length}`,
      `      max-choices ${correct.length}`,
    );
  }
  lines.push(`      selections [`);
  for (const q of correct) lines.push(`        [ quote ${s(q)} assess [ correct ] ]`);
  lines.push(`      ] {}`, `    ]`);
  return lines;
};

const extendedTextPart = (stem: string, rubric: any[]): string[] => [
  `    extended-text [`,
  `      prompt ${s(stem)}`,
  `      rubric [`,
  ...rubric.map((b: any) => `        [ points ${Number(b?.score) || 0} descriptor ${s(b?.descriptor)} ]`),
  `      ] {}`,
  `    ]`,
];

export function port(src: SourceItem, compiled: any): string {
  const stems = src.stems.length ? src.stems : ["Respond to the passage."];
  const parts: string[] = [];

  if (src.handScored) {
    parts.push(...extendedTextPart(stems[0], compiled?.rubric ?? []));
  } else {
    src.parts.forEach((p, i) => {
      const stem = stems[i] ?? stems[stems.length - 1];
      parts.push(...(src.type === "hot-text" ? hottextPart(p, stem) : choicePart(p, stem)));
    });
  }

  // Conjunctive is for the two-part model, where a right claim with the wrong evidence earns
  // nothing. A one-part item is additive and worth the sum of its parts, which is the point.
  const conjunctive = src.parts.length > 1;
  return [
    `item [`,
    ...stimulus(compiled),
    ...(conjunctive ? [`  scoring "conjunctive"`, `  points ${src.points}`] : []),
    `  parts [`,
    ...parts,
    `  ] {}`,
    `]..`,
  ].join("\n");
}
