// SPDX-License-Identifier: MIT
// Serializes a composed assessment item into clean, portable rich text (HTML + plain text) for
// the "Copy" button, so teachers can paste a WYSIWYG question/answer-key into Google Docs or Word.
// We serialize from the item DATA MODEL (not the rendered Tailwind DOM) so the output is
// self-contained, inline-styled, and free of class names and form controls.
//
//   - Questions mode (id "preview") -> the question only.
//   - Answers mode -> the stem plus just the correct answer(s) (answersToHtml/answersToText),
//     mirroring the on-screen Answers view: no distractors, no passage, no analysis.
//   - Rationale mode (id "review") -> the question PLUS a clean teacher answer key (correct option
//     marked, the answer key, the short-text rubric, and the exemplar/correct inference). Each
//     wrong option is followed by the same amber annotation the on-screen Rationale view
//     interleaves beneath it (error type · plausibility → tie — rationale). It still omits
//     composition warnings.
//   - Both modes LEAD with the reading passage(s) (deduped), then the question(s), so the copy is
//     a self-contained passage+questions block. "Copy passage" (passagesToHtml/passagesToText)
//     still serializes just the reading passage(s), with its metadata header.
import type { Mode } from "./ModeToggle";
import { answerRows } from "./answers";

// Rationale (mode id "review") is the mode that marks the answers inside the question and carries
// the analysis; Answers copies the answer key on its own, via answersToHtml/answersToText below.
const revealsAnswers = (mode: Mode) => mode === "review";
const showsAnalysis = (mode: Mode) => mode === "review";

const esc = (s: any): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const P = (html: string, style = "margin:0 0 4px"): string => `<p style="${style}">${html}</p>`;
const NUM = (n: any): string => `<span style="color:#9ca3af">${esc(n)}</span>`;
// The correct-answer check mark: green-700 (#15803d) — lighter than green-800 but still dark enough
// to stay legible when the copied answer key is printed in grayscale.
const CHECK = '<strong style="color:#15803d">✓</strong>';

// Mirrors ItemView's pill row: Claim / Target / Task Model (abbreviated C · T · TM), leading, then
// the item-type label, standards, DoK, and dimension. Copied at the head of each item AND each
// passage so the copied question / answer key / passage carries the same metadata as the on-screen
// view.
const TYPE_LABEL: Record<string, string> = {
  "ebsr": "EBSR",
  "hot-text": "Hot Text",
  "short-text": "Short Text",
  "multiple-choice": "Multiple Choice",
  "multi-select": "Multi-Select",
};

const META_STYLE = "margin:0 0 6px;font-size:9pt;color:#6b7280";

// Claim / Target parse out of the `target` tag (e.g. "c1-t9" → C1, T9); the task-model number is
// supplied by the compiler. C · T · TM lead the row, matching ItemView.
function metaParts(item: any): string[] {
  const target: string = typeof item.target === "string" ? item.target : "";
  const claimNum = (target.match(/c(\d+)/) ?? [])[1];
  const targetNum = (target.match(/t(\d+)/) ?? [])[1];
  return [
    claimNum && `C${claimNum}`,
    targetNum && `T${targetNum}`,
    item.taskModel && `TM${item.taskModel}`,
    TYPE_LABEL[item.type] ?? item.type,
    ...(item.standards ?? []),
    item.dok,
    item.dimension,
  ].filter(Boolean);
}

// The metadata pill row as an HTML paragraph / a plain-text line (empty when the item has none).
const metaHtml = (item: any): string => {
  const parts = metaParts(item);
  return parts.length ? P(parts.map(esc).join(" &middot; "), META_STYLE) : "";
};
const metaText = (item: any): string => metaParts(item).join(" · ");

function passageHtml(p: any): string {
  if (!p) return "";
  const heading = p.heading ? P(`<strong>${esc(p.heading)}</strong>`) : "";
  const lines = (p.lines ?? []).map((l: any) => P(`${NUM(l.id)} ${esc(l.text)}`)).join("");
  return heading + lines;
}

// Plain reading passage as text (heading + numbered lines), no metadata header.
function passageText(p: any): string {
  if (!p) return "";
  const lines: string[] = [];
  if (p.heading) lines.push(p.heading);
  for (const l of p.lines ?? []) lines.push(`${l.id} ${l.text}`);
  return lines.join("\n");
}

// The distractor analysis for a given part ("A"/"B"), indexed by option key — the same lookup the
// Review renderers do (analysisIndex in itemKit), so the copy annotates the same options.
function analysisMap(item: any, part: string): Record<string, any> {
  const m: Record<string, any> = {};
  for (const d of item.distractorAnalysis ?? []) if (d.part === part) m[d.key] = d;
  return m;
}

// The amber annotation the Review view shows beneath each wrong option — bold error type (or
// evidence status), then "· p=<plausibility>", the graph tie, and "— <rationale>" — colored to
// match `text-amber-700` (#b45309). Empty when there is no analysis for the option.
function annotationHtml(a: any): string {
  if (!a) return "";
  const plaus = typeof a.plausibility === "number" ? ` &middot; p=${esc(a.plausibility)}` : "";
  const ties = a.tiesTo && !Array.isArray(a.tiesTo) ? ` &rarr; ${esc(a.tiesTo)}` : "";
  const rationale = a.rationale ? ` — ${esc(a.rationale)}` : "";
  return P(
    `<strong>${esc(a.errorType || a.status)}</strong>${plaus}${ties}${rationale}`,
    "margin:2px 0 8px 24px;font-size:9pt;color:#b45309",
  );
}
function annotationText(a: any): string {
  if (!a) return "";
  const plaus = typeof a.plausibility === "number" ? ` · p=${a.plausibility}` : "";
  const ties = a.tiesTo && !Array.isArray(a.tiesTo) ? ` → ${a.tiesTo}` : "";
  const rationale = a.rationale ? ` — ${a.rationale}` : "";
  return `    ${a.errorType || a.status}${plaus}${ties}${rationale}`;
}

// One option line: "A. text" (Part B EBSR options are quoted). Correct options are bolded with a ✓
// in Rationale mode, where each wrong option is additionally followed by its amber annotation
// (interleaved, as on screen) via `ann(key)`.
function optionsHtml(options: any[], mode: Mode, quote: boolean, ann?: (key: string) => any): string {
  return (options ?? [])
    .map((o: any) => {
      const correct = revealsAnswers(mode) && o.correct;
      const txt = quote ? `<em>&ldquo;${esc(o.text)}&rdquo;</em>` : esc(o.text);
      const body = `${esc(o.key)}. ${txt}`;
      const row = P(correct ? `<strong>${body}</strong> ${CHECK}` : body);
      const note = showsAnalysis(mode) && !o.correct && ann ? annotationHtml(ann(o.key)) : "";
      return row + note;
    })
    .join("");
}

// Hot Text Part B: the passage keeps its paragraph format, with each sentence individually
// selectable. Group the selectable sentences by paragraph (lineId) — one <p> per paragraph,
// sentences inline; correct sentences are bolded with a ✓ in the revealing modes.
function selectableHtml(selectable: any[], mode: Mode): string {
  const groups = groupByLine(selectable ?? []);
  return groups
    .map((g) =>
      P(
        g.units
          .map((s: any) => {
            const correct = revealsAnswers(mode) && s.correct;
            return correct ? `<strong>${esc(s.text)}</strong> ${CHECK}` : esc(s.text);
          })
          .join(" "),
      ),
    )
    .join("");
}

// Word-select Hot Text (T10 TM3): render the excerpt inline. The candidate (clickable) words are
// both underlined AND bracketed: the underline distinguishes them in rich text (Google Docs
// preserves `text-decoration:underline`, unlike a `border-bottom`), while the brackets are literal
// characters that survive even when a target strips formatting (e.g. Docs "paste without
// formatting", which derives plain text from the HTML and ignores the clipboard's text/plain).
// In the revealing modes the correct word is also bolded with a ✓.
function wordSelectHtml(wordSelect: any, mode: Mode): string {
  return (wordSelect?.tokens ?? [])
    .map((t: any) => {
      const correct = revealsAnswers(mode) && t.correct;
      let word = esc(t.text);
      if (t.selectable) {
        const u = `<u style="text-decoration:underline;text-decoration-style:dotted">${word}</u>`;
        const bracketed = `[${correct ? `${u} ${CHECK}` : u}]`;
        word = correct ? `<strong>${bracketed}</strong>` : bracketed;
      }
      return `${esc(t.pre ?? "")}${word}${esc(t.post ?? "")}`;
    })
    .join(" ");
}

// Group selectable sentence units into their paragraphs, preserving order.
function groupByLine(selectable: any[]): { lineId: number; units: any[] }[] {
  const groups: { lineId: number; units: any[] }[] = [];
  for (const s of selectable) {
    const last = groups[groups.length - 1];
    if (last && last.lineId === s.lineId) last.units.push(s);
    else groups.push({ lineId: s.lineId, units: [s] });
  }
  return groups;
}

// HTML for one composed item (the question, plus the answer key in the revealing modes). The
// passage is not embedded per-item; itemsToHtml/itemsToText prepend the deduped passage(s) for the
// whole copy.
export function itemToHtml(item: any, mode: Mode): string {
  if (!item) return "";
  const reveal = revealsAnswers(mode);
  const aA = analysisMap(item, "A");
  const aB = analysisMap(item, "B");
  const out: string[] = [];
  out.push(metaHtml(item));
  if (item.stem?.leadIn) out.push(P(`<em>${esc(item.stem.leadIn)}</em>`, "margin:8px 0;color:#6b7280"));

  if ((item.type === "ebsr" || item.type === "hot-text") && item.partA) {
    out.push(P(`<strong>Part A.</strong> ${esc(item.stem?.partA)}`, "margin:8px 0 4px"));
    out.push(optionsHtml(item.partA?.options, mode, false, (k) => aA[k]));
    out.push(P(`<strong>Part B.</strong> ${esc(item.stem?.partB)}`, "margin:8px 0 4px"));
    out.push(
      item.type === "ebsr"
        ? optionsHtml(item.partB?.options, mode, true, (k) => aB[k])
        : selectableHtml(item.selectable, mode),
    );
  } else if (item.type === "hot-text" && item.wordSelect) {
    // Word-select Hot Text (T10): the authored stem (definition) + the excerpt, marking the correct word.
    out.push(P(`<strong>${esc(item.stem?.partA)}</strong>`, "margin:8px 0 4px"));
    out.push(P(wordSelectHtml(item.wordSelect, mode)));
  } else if (item.type === "hot-text") {
    // Single-part Hot Text (evidence): the authored stem (which states the inference) + selectable.
    out.push(P(`<strong>${esc(item.stem?.partA)}</strong>`, "margin:8px 0 4px"));
    out.push(selectableHtml(item.selectable, mode));
  } else if (item.type === "multiple-choice" || item.type === "multi-select") {
    out.push(P(`<strong>${esc(item.stem?.partA)}</strong>`, "margin:8px 0 4px"));
    out.push(optionsHtml(item.choice?.options, mode, false, (k) => aA[k]));
  } else if (item.type === "short-text") {
    out.push(P(`<strong>${esc(item.prompt)}</strong>`, "margin:8px 0 4px"));
    if (!reveal) out.push(P("Answer: ___________________________________________", "margin:8px 0;color:#9ca3af"));
  }

  if (reveal) {
    const key: string[] = [];
    if (item.answerKey?.partA) key.push(`Part A &mdash; ${esc(item.answerKey.partA)}`);
    if (item.answerKey?.partB && item.type !== "hot-text") key.push(`Part B &mdash; ${esc(item.answerKey.partB)}`);
    if (item.type === "hot-text") {
      const ids = (item.selectable ?? []).filter((s: any) => s.correct).map((s: any) => s.id);
      if (ids.length) key.push(`${item.partA ? "Part B" : "Answer"} &mdash; any ${item.selectCount ?? 1} of: ${esc(ids.join(", "))}`);
    }
    if (item.answerKey?.word) key.push(`Answer &mdash; ${esc(item.answerKey.word)}`);
    if (item.answerKey?.choice) key.push(`Answer &mdash; ${esc(item.answerKey.choice)}`);
    if (Array.isArray(item.answerKey?.choices) && item.answerKey.choices.length) key.push(`Answer &mdash; ${esc(item.answerKey.choices.join(", "))}`);
    if (key.length) out.push(P(`<strong>Answer key:</strong> ${key.join("; ")}`, "margin:8px 0 4px"));

    // The rubric is scoring, not an answer — Rationale only.
    if (showsAnalysis(mode) && item.type === "short-text" && Array.isArray(item.rubric) && item.rubric.length) {
      out.push(P("<strong>Scoring rubric:</strong>", "margin:8px 0 4px"));
      out.push(
        `<ul style="margin:0 0 4px;padding-left:20px">${item.rubric
          .map((r: any) => `<li><strong>${esc(r.score)}</strong> &mdash; ${esc(r.descriptor)}</li>`)
          .join("")}</ul>`,
      );
    }

    // Short Text shows the answer-key rationale ("Exemplar inference"); EBSR / Hot Text show the
    // correct claim's statement ("Correct inference") — mirroring the on-screen renderers.
    const shortText = item.type === "short-text";
    const exemplar = shortText
      ? item.answerKey?.rationale || item.review?.correctClaim?.text
      : item.review?.correctClaim?.text || item.answerKey?.rationale;
    if (exemplar) {
      out.push(P(`<strong>${shortText ? "Exemplar inference" : "Correct inference"}:</strong> ${esc(exemplar)}`, "margin:8px 0 4px"));
    }
  }

  return out.filter(Boolean).join("");
}

// Plain-text fallback (mirrors itemToHtml, no markup).
export function itemToText(item: any, mode: Mode): string {
  if (!item) return "";
  const reveal = revealsAnswers(mode);
  const out: string[] = [];
  const meta = metaText(item);
  if (meta) out.push(meta, "");
  if (item.stem?.leadIn) out.push(item.stem.leadIn, "");

  const aA = analysisMap(item, "A");
  const aB = analysisMap(item, "B");
  const opt = (o: any, quote: boolean) => {
    const mark = reveal && o.correct ? " ✓" : "";
    return `${o.key}. ${quote ? `“${o.text}”` : o.text}${mark}`;
  };
  // Push an option line, and — in Rationale mode — interleave its amber annotation beneath it.
  const pushOpt = (o: any, quote: boolean, map: Record<string, any>) => {
    out.push(opt(o, quote));
    if (showsAnalysis(mode) && !o.correct) {
      const note = annotationText(map[o.key]);
      if (note.trim()) out.push(note);
    }
  };

  const hotTextLines = () => {
    // Hot Text: one line per paragraph, sentences inline; correct sentences marked when revealed.
    for (const g of groupByLine(item.selectable ?? [])) {
      out.push(g.units.map((s: any) => `${s.text}${reveal && s.correct ? " ✓" : ""}`).join(" "));
    }
  };
  if ((item.type === "ebsr" || item.type === "hot-text") && item.partA) {
    out.push(`Part A. ${item.stem?.partA ?? ""}`);
    for (const o of item.partA?.options ?? []) pushOpt(o, false, aA);
    out.push("", `Part B. ${item.stem?.partB ?? ""}`);
    if (item.type === "ebsr") {
      for (const o of item.partB?.options ?? []) pushOpt(o, true, aB);
    } else {
      hotTextLines();
    }
  } else if (item.type === "hot-text" && item.wordSelect) {
    out.push(item.stem?.partA ?? ""); // word-select: authored stem states the definition
    // candidate words are bracketed so the clickable choices are visible in plain text
    out.push(
      (item.wordSelect.tokens ?? [])
        .map((t: any) => {
          const core = t.selectable ? `[${t.text}${reveal && t.correct ? " ✓" : ""}]` : t.text;
          return `${t.pre ?? ""}${core}${t.post ?? ""}`;
        })
        .join(" "),
    );
  } else if (item.type === "hot-text") {
    out.push(item.stem?.partA ?? ""); // single-part: authored stem states the inference
    hotTextLines();
  } else if (item.type === "multiple-choice" || item.type === "multi-select") {
    out.push(item.stem?.partA ?? "");
    for (const o of item.choice?.options ?? []) pushOpt(o, false, aA);
  } else if (item.type === "short-text") {
    out.push(item.prompt ?? "");
    if (!reveal) out.push("", "Answer: ___________________________________________");
  }

  if (reveal) {
    const key: string[] = [];
    if (item.answerKey?.partA) key.push(`Part A — ${item.answerKey.partA}`);
    if (item.answerKey?.partB && item.type !== "hot-text") key.push(`Part B — ${item.answerKey.partB}`);
    if (item.type === "hot-text") {
      const ids = (item.selectable ?? []).filter((s: any) => s.correct).map((s: any) => s.id);
      if (ids.length) key.push(`${item.partA ? "Part B" : "Answer"} — any ${item.selectCount ?? 1} of: ${ids.join(", ")}`);
    }
    if (item.answerKey?.word) key.push(`Answer — ${item.answerKey.word}`);
    if (item.answerKey?.choice) key.push(`Answer — ${item.answerKey.choice}`);
    if (Array.isArray(item.answerKey?.choices) && item.answerKey.choices.length) key.push(`Answer — ${item.answerKey.choices.join(", ")}`);
    if (key.length) out.push("", `Answer key: ${key.join("; ")}`);
    if (showsAnalysis(mode) && item.type === "short-text" && Array.isArray(item.rubric) && item.rubric.length) {
      out.push("", "Scoring rubric:");
      for (const r of item.rubric) out.push(`  ${r.score} — ${r.descriptor}`);
    }
    const shortText = item.type === "short-text";
    const exemplar = shortText
      ? item.answerKey?.rationale || item.review?.correctClaim?.text
      : item.review?.correctClaim?.text || item.answerKey?.rationale;
    if (exemplar) out.push("", `${shortText ? "Exemplar inference" : "Correct inference"}: ${exemplar}`);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Dedupe the reading passage(s) across items — a set of items typically shares one passage, so
// the Passage view (and its Copy button) collapses identical passages to one. Shared by the
// on-screen PassageView and the passage serializers below so they never diverge.
// Deduped passages paired with the FIRST item that carries each — so the passage copy can prefix
// the same metadata header (C · T · TM · type · …) as the question/answer-key copy.
function uniquePassageEntries(items: any[]): { passage: any; item: any }[] {
  const seen = new Set<string>();
  const out: { passage: any; item: any }[] = [];
  for (const item of items ?? []) {
    const p = item?.passage;
    if (!p) continue;
    const key = `${p.heading} ${(p.lines ?? []).map((l: any) => `${l.id}:${l.text}`).join("\n")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ passage: p, item });
  }
  return out;
}

export function uniquePassages(items: any[]): any[] {
  return uniquePassageEntries(items).map((e) => e.passage);
}

// The Passage view's copy: just the reading passage(s), deduped, as rich text. With `sections` each
// passage gets a "Passage" heading (used by the single "Copy" button in the Passage view).
export function passagesToHtml(items: any[], title?: string, sections = false): string {
  const head0 = sections ? sectionTitleHtml("Passage") : "";
  const body = uniquePassageEntries(items)
    .map(({ passage, item }) => `<div>${head0}${metaHtml(item)}${passageHtml(passage)}</div>`)
    .join('<p style="margin:14px 0"></p>');
  const head = title ? `<h3 style="margin:0 0 8px">${esc(title)}</h3>` : "";
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.4;color:#111827">${head}${body}</div>`;
}

export function passagesToText(items: any[], title?: string, sections = false): string {
  const body = uniquePassageEntries(items)
    .map(({ passage, item }) => {
      const meta = metaText(item);
      return (sections ? "Passage\n\n" : "") + (meta ? `${meta}\n\n` : "") + passageText(passage);
    })
    .join(sections ? "\n\n\n" : "\n\n———\n\n");
  return (title ? `${title}\n\n` : "") + body;
}

// Section titles for the copy buttons: "Passage" over the reading passage, then the view's own
// name over each item — "Question" / "Answers" / "Rationale" ("#n"-numbered in the multi-item
// "Copy All" worksheet, bare for the single-item "Copy"). Only emitted when `sections` is true.
const SECTION_TITLE_STYLE = "margin:16px 0 6px;font-size:12pt;font-weight:bold;color:#111827";
const sectionTitleHtml = (label: string): string => P(`<strong>${esc(label)}</strong>`, SECTION_TITLE_STYLE);
const MODE_SECTION: Record<string, string> = { review: "Rationale", answers: "Answers", preview: "Question" };
const itemSectionLabel = (mode: Mode, i: number, numbered: boolean): string =>
  `${MODE_SECTION[mode] ?? "Question"}${numbered ? ` #${i + 1}` : ""}`;

// Joins the currently visible item(s) for copying, wrapped in a base-font container.
// The Questions / Review copy leads with the reading passage(s) (deduped, no metadata header),
// then the question(s) — so a teacher pastes a self-contained "passage + questions" block. The
// per-question metadata header still rides on each item; the standalone "Copy passage" button
// (passagesToHtml/Text) keeps its own metadata header. With `sections`, each block gets a heading
// ("Passage", "Question #n" / "Answer Key #n") — used by the "Copy All" worksheet.
export function itemsToHtml(
  items: any[],
  mode: Mode,
  title?: string,
  sections = false,
  numbered = false,
): string {
  const passages = uniquePassages(items).map(
    (p) => `<div>${sections ? sectionTitleHtml("Passage") : ""}${passageHtml(p)}</div>`,
  );
  const questions = (items ?? []).map(
    (it, i) =>
      `<div>${sections ? sectionTitleHtml(itemSectionLabel(mode, i, numbered)) : ""}${itemToHtml(it, mode)}</div>`,
  );
  const body = [...passages, ...questions].join('<p style="margin:14px 0"></p>');
  const head = title ? `<h3 style="margin:0 0 8px">${esc(title)}</h3>` : "";
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.4;color:#111827">${head}${body}</div>`;
}

export function itemsToText(
  items: any[],
  mode: Mode,
  title?: string,
  sections = false,
  numbered = false,
): string {
  const passages = uniquePassages(items).map((p) => (sections ? "Passage\n\n" : "") + passageText(p));
  const questions = (items ?? []).map(
    (it, i) => (sections ? `${itemSectionLabel(mode, i, numbered)}\n\n` : "") + itemToText(it, mode),
  );
  // With section titles the headings delimit the blocks (two blank lines above each); without them
  // fall back to the horizontal-rule separator.
  const body = [...passages, ...questions].filter(Boolean).join(sections ? "\n\n\n" : "\n\n———\n\n");
  return (title ? `${title}\n\n` : "") + body;
}

// The Answers view's copy: the stem, then just the correct answer(s), from the same `answerRows`
// the on-screen Answers body renders — no distractors, no passage, no analysis. Each item keeps
// its metadata header, and with `sections` gets an "Answers" heading (numbered by "Copy All").
const stemOf = (item: any): string =>
  item.type === "short-text" ? (item.prompt ?? "") : (item.stem?.partA ?? "");

function answerRowsHtml(item: any): string {
  const rows = answerRows(item);
  const stems = [stemOf(item), item.stem?.partB]
    .filter(Boolean)
    .map((t: any) => P(`<strong>${esc(t)}</strong>`, "margin:8px 0 4px"))
    .join("");
  if (rows.length === 0) return stems + P("No answer key for this item.", "margin:8px 0 4px;color:#6b7280");
  return (
    stems +
    rows
      .map((r) => {
        const note = r.note ? ` <span style="font-weight:normal;color:#6b7280">(${esc(r.note)})</span>` : "";
        const head = P(`<strong>${esc(r.label)}</strong>${note}`, "margin:8px 0 2px");
        return head + r.values.map((v) => P(`${CHECK} ${esc(v)}`, "margin:0 0 2px 12px")).join("");
      })
      .join("")
  );
}

function answerRowsText(item: any): string {
  const out: string[] = [stemOf(item), item.stem?.partB].filter(Boolean) as string[];
  const rows = answerRows(item);
  if (rows.length === 0) {
    out.push("", "No answer key for this item.");
  } else {
    for (const r of rows) {
      out.push("", `${r.label}${r.note ? ` (${r.note})` : ""}:`);
      for (const v of r.values) out.push(`  ✓ ${v}`);
    }
  }
  return out.join("\n").trim();
}

export function answersToHtml(items: any[], title?: string, sections = false, numbered = false): string {
  const body = (items ?? [])
    .map((item, i) => {
      const head = sections ? sectionTitleHtml(`Answers${numbered ? ` #${i + 1}` : ""}`) : "";
      return `<div>${head}${metaHtml(item)}${answerRowsHtml(item)}</div>`;
    })
    .join('<p style="margin:14px 0"></p>');
  const head = title ? `<h3 style="margin:0 0 8px">${esc(title)}</h3>` : "";
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.4;color:#111827">${head}${body}</div>`;
}

export function answersToText(items: any[], title?: string, sections = false, numbered = false): string {
  const body = (items ?? [])
    .map((item, i) => {
      const meta = metaText(item);
      return (
        (sections ? `Answers${numbered ? ` #${i + 1}` : ""}\n\n` : "") +
        (meta ? `${meta}\n\n` : "") +
        answerRowsText(item)
      );
    })
    .join(sections ? "\n\n\n" : "\n\n———\n\n");
  return (title ? `${title}\n\n` : "") + body;
}

// Writes rich text (HTML + plain) to the clipboard. Primary path: the async Clipboard API with a
// ClipboardItem (both flavors, so Docs/Word take the HTML and a plain editor takes the text).
// Fallback: a hidden contenteditable + execCommand("copy") for older browsers.
export async function copyRichText(html: string, text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof ClipboardItem !== "undefined") {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const el = document.createElement("div");
    el.setAttribute("contenteditable", "true");
    el.style.position = "fixed";
    el.style.left = "-9999px";
    el.style.opacity = "0";
    el.innerHTML = html;
    document.body.appendChild(el);
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    const ok = document.execCommand("copy");
    sel?.removeAllRanges();
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
