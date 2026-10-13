// SPDX-License-Identifier: MIT
// Short Text (Task Model 3): constructed response. A prompt + a text box; hand-scored 0/1/2
// against the rubric (no auto-scoring). There is no option to mark correct, so Rationale shows the
// scoring rubric and the exemplar response. (The Answers view shows the exemplar on its own — see
// ItemView's answers body.)
import { useState } from "react";
import { StemLine, revealsAnswers, type Mode } from "./itemKit";

export function ShortTextItem({
  item,
  mode,
  respond,
}: {
  item: any;
  mode: Mode;
  respond: (r: any) => void;
}) {
  const [text, setText] = useState("");
  // Hand-scored: the "answer" is the exemplar the rubric is applied against — the authored
  // rationale, falling back to the correct claim the item was composed from.
  const exemplar = item.answerKey?.rationale || item.review?.correctClaim?.text;
  return (
    <div className="flex flex-col gap-3">
      <StemLine>{item.prompt}</StemLine>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          respond({ text: e.target.value });
        }}
        rows={5}
        placeholder="Type your answer here…"
        className="appearance-none w-full rounded-md border border-zinc-300 p-2 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none"
      />
      {mode === "preview" && text.trim() !== "" && (
        <p className="text-xs text-zinc-500">
          This constructed response is hand-scored against a 0–2 rubric — switch to Rationale to see it.
        </p>
      )}
      {revealsAnswers(mode) && (
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
          <p className="text-xs font-semibold text-zinc-700 mb-2">Scoring rubric (hand-scored)</p>
          <ul className="flex flex-col gap-1">
            {(item.rubric ?? []).map((r: any) => (
              <li key={r.score} className="text-xs text-zinc-700">
                <span className="font-semibold">{r.score}</span> — {r.descriptor}
              </li>
            ))}
          </ul>
          {exemplar && (
            <p className="text-xs text-zinc-600 mt-2">
              <span className="font-semibold text-green-700">✓</span>{" "}
              <span className="font-semibold">Exemplar response:</span> {exemplar}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
