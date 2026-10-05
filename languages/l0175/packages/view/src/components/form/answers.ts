// SPDX-License-Identifier: MIT
// The correct answer(s) for a composed item, derived from the item DATA MODEL — shared by the
// "Answers" view (ItemView's answers body) and its copy serializer (answersToHtml/answersToText
// in copy.ts) so the screen and the clipboard never diverge.
//
// One row per answerable part: EBSR / two-part Hot Text yield "Part A" + "Part B", the
// single-part types yield one "Answer", and Short Text — a constructed response with no discrete
// key — yields a sample correct answer (the authored exemplar). `note` carries the selection rule
// ("any 2 of these") where the key is a choose-N set rather than a single option.

export type AnswerRow = { label: string; values: string[]; note?: string };

const str = (s: any): string => String(s ?? "");

// "A — Each design solved a limit of the last." (Part B EBSR options are quoted, as on screen).
const optionLine = (o: any, quote: boolean): string =>
  `${str(o.key)} — ${quote ? `“${str(o.text)}”` : str(o.text)}`;

const correctOptions = (options: any[] | undefined, quote = false): string[] =>
  (options ?? []).filter((o: any) => o.correct).map((o: any) => optionLine(o, quote));

// Hot Text sentence key: "1.1 — “A.”" — the selectable id plus the sentence it names.
const correctSentences = (item: any): string[] =>
  (item.selectable ?? [])
    .filter((s: any) => s.correct)
    .map((s: any) => `${str(s.id)} — “${str(s.text)}”`);

// The valid sentences are a superset of the required count, so the key states the rule.
const selectNote = (item: any, valid: number): string | undefined => {
  const count = item.selectCount ?? 1;
  return valid > count ? `any ${count} of these` : undefined;
};

export function answerRows(item: any): AnswerRow[] {
  if (!item) return [];
  const rows: AnswerRow[] = [];

  if (item.type === "ebsr") {
    rows.push({ label: "Part A", values: correctOptions(item.partA?.options) });
    rows.push({ label: "Part B", values: correctOptions(item.partB?.options, true) });
  } else if (item.type === "hot-text" && item.wordSelect) {
    const words = (item.wordSelect.tokens ?? []).filter((t: any) => t.correct).map((t: any) => str(t.text));
    rows.push({ label: "Answer", values: words.length ? words : [str(item.answerKey?.word)] });
  } else if (item.type === "hot-text") {
    const sentences = correctSentences(item);
    if (item.partA) {
      rows.push({ label: "Part A", values: correctOptions(item.partA.options) });
      rows.push({ label: "Part B", values: sentences, note: selectNote(item, sentences.length) });
    } else {
      rows.push({ label: "Answer", values: sentences, note: selectNote(item, sentences.length) });
    }
  } else if (item.type === "multiple-choice") {
    rows.push({ label: "Answer", values: correctOptions(item.choice?.options) });
  } else if (item.type === "multi-select") {
    const values = correctOptions(item.choice?.options);
    rows.push({ label: "Answer", values, note: values.length > 1 ? `select all ${values.length}` : undefined });
  } else if (item.type === "short-text") {
    // A constructed response has no key, so the answer is a SAMPLE correct one: the authored
    // exemplar the rubric is applied against, falling back to the claim the item was composed from.
    const exemplar = item.answerKey?.rationale || item.review?.correctClaim?.text;
    if (exemplar) rows.push({ label: "Sample correct answer", values: [str(exemplar)] });
  }

  return rows.filter((r) => r.values.filter((v) => v.trim() !== "").length > 0);
}
