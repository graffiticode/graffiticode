// SPDX-License-Identifier: MIT
// Renders one composed assessment item: a metadata header, the lead-in, and the body — the
// task-model component in Questions and Rationale (Rationale reveals the answers and adds the
// analysis, key, scoring, and warnings), or, in Answers, just the stem plus the correct answer(s).
// The passage is never shown here — it lives in its own "Passage" tab.
import { Pill, StemLine, type Mode } from "./itemKit";
import { answerRows, type AnswerRow } from "./answers";
import { EbsrItem } from "./EbsrItem";
import { HotTextItem } from "./HotTextItem";
import { ShortTextItem } from "./ShortTextItem";
import { MultipleChoiceItem } from "./MultipleChoiceItem";
import { MultiSelectItem } from "./MultiSelectItem";
import { WordSelectItem } from "./WordSelectItem";
import { Warnings } from "./Warnings";

const TYPE_LABEL: Record<string, string> = {
  "ebsr": "EBSR",
  "hot-text": "Hot Text",
  "short-text": "Short Text",
  "multiple-choice": "Multiple Choice",
  "multi-select": "Multi-Select",
};

// The item's metadata pill row: Claim / Target / Task Model (abbreviated C · T · TM) parsed out of
// the `target` tag (e.g. "c1-t4" → C1, T4; the task-model number comes from core), then the item
// type, standards, DoK, and dimension. Exported so the Answers view heads each answer key with the
// same row as the question it answers.
export function MetaPills({ item }: { item: any }) {
  const target: string = typeof item.target === "string" ? item.target : "";
  const claimNum = (target.match(/c(\d+)/) ?? [])[1];
  const targetNum = (target.match(/t(\d+)/) ?? [])[1];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {claimNum && <Pill>C{claimNum}</Pill>}
      {targetNum && <Pill>T{targetNum}</Pill>}
      {item.taskModel && <Pill>TM{item.taskModel}</Pill>}
      <Pill>{TYPE_LABEL[item.type] ?? item.type}</Pill>
      {(item.standards ?? []).map((s: string) => (
        <Pill key={s}>{s}</Pill>
      ))}
      {item.dok && <Pill>{item.dok}</Pill>}
      {item.dimension && <Pill>{item.dimension}</Pill>}
    </div>
  );
}

export function Passage({ passage }: { passage: any }) {
  if (!passage) return null;
  return (
    <div className="font-sans rounded-md border border-zinc-200 bg-zinc-50 p-3">
      <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1">{passage.heading}</p>
      <div className="flex flex-col gap-0.5">
        {passage.lines.map((l: any) => (
          <p key={l.id} className="text-sm text-zinc-800 leading-relaxed">
            <span className="text-zinc-400 mr-2 select-none">{l.id}</span>
            {l.text}
          </p>
        ))}
      </div>
    </div>
  );
}

// The answer key, per task model: EBSR / two-part Hot Text key both parts; the single-part types
// (multiple-choice, multi-select, word-select Hot Text) key one answer under `choice`/`choices`/
// `word`. Short Text has no key — only the exemplar, shown by ShortTextItem.
function answerKeyParts(item: any): { label: string; value: string }[] {
  const key = item.answerKey ?? {};
  const parts: { label: string; value: string }[] = [];
  if (key.partA) parts.push({ label: "Part A", value: String(key.partA) });
  if (key.partB) {
    parts.push({
      label: "Part B",
      value: item.type === "hot-text" ? `any ${item.selectCount ?? 1} of: ${key.partB}` : String(key.partB),
    });
  }
  if (key.choice) parts.push({ label: "Answer", value: String(key.choice) });
  if (Array.isArray(key.choices) && key.choices.length) {
    parts.push({ label: `Answer (select ${item.selectCount ?? key.choices.length})`, value: key.choices.join(", ") });
  }
  if (key.word) parts.push({ label: "Answer", value: String(key.word) });
  return parts;
}

// The "Answers" body: the question's stem, then just the correct answer(s) — no distractors, no
// passage, no analysis. Every task model reduces to the same shape (see answerRows): one row per
// answerable part, each value marked with a ✓.
function AnswerRowView({ row }: { row: AnswerRow }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-xs font-semibold text-zinc-700">
        {row.label}
        {row.note && <span className="ml-1.5 font-normal text-zinc-500">({row.note})</span>}
      </p>
      {row.values.map((v, i) => (
        <p key={i} className="text-sm text-zinc-900">
          <span className="text-green-600 font-semibold mr-1.5 select-none">✓</span>
          {v}
        </p>
      ))}
    </div>
  );
}

function AnswersBody({ item }: { item: any }) {
  const rows = answerRows(item);
  const stem = item.type === "short-text" ? item.prompt : item.stem?.partA;
  return (
    <div className="flex flex-col gap-3">
      {stem && <StemLine>{stem}</StemLine>}
      {item.stem?.partB && <StemLine>{item.stem.partB}</StemLine>}
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">No answer key for this item.</p>
      ) : (
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 flex flex-col gap-3">
          {rows.map((row, i) => (
            <AnswerRowView key={i} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewPanel({ item }: { item: any }) {
  const r = item.review ?? {};
  const parts = answerKeyParts(item);
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-3 flex flex-col gap-2">
      <p className="text-xs font-semibold text-zinc-700">Answer key &amp; scoring</p>
      <p className="text-xs text-zinc-600">
        {parts.map((p, i) => (
          <span key={p.label}>
            {i > 0 && " · "}
            {p.label}: <span className="font-semibold">{p.value}</span>
          </span>
        ))}
      </p>
      <p className="text-xs text-zinc-600">{r.scoring}</p>
      {r.correctClaim && (
        <p className="text-xs text-zinc-600">
          <span className="font-semibold">Correct inference:</span> {r.correctClaim.text}
        </p>
      )}
      {r.alternativeClaims > 0 && (
        <p className="text-xs text-zinc-500">
          Selected from {r.alternativeClaims + 1} supported claim(s) matching this dimension.
        </p>
      )}
    </div>
  );
}

export function ItemView({
  item,
  mode,
  apply,
}: {
  item: any;
  mode: Mode;
  apply: (action: any) => void;
}) {
  // The shared View's default reducer merges a response's args into the TOP LEVEL of `data`
  // ({...data, ...args}). A single-item program's data IS the item, so spreading the raw answer
  // there overwrote the item's own fields — `{choice: "A"}` clobbered `item.choice` (the options
  // object), `{partA: "C"}` clobbered `item.partA` — and the next render threw on the missing
  // options, blanking the form. Namespacing under one `response` key keeps answers out of the
  // item's namespace.
  const respond = (r: any) => apply({ type: "response", args: { response: { itemId: item.id, ...r } } });
  // "Answers" replaces the answerable body with the answer itself; every other mode renders the
  // task-model component (Questions plain, Rationale with the answers and analysis revealed).
  const body =
    mode === "answers" ? (
      <AnswersBody item={item} />
    ) : item.type === "ebsr" ? (
      <EbsrItem item={item} mode={mode} respond={respond} />
    ) : item.type === "hot-text" ? (
      item.wordSelect ? (
        <WordSelectItem item={item} mode={mode} respond={respond} />
      ) : (
        <HotTextItem item={item} mode={mode} respond={respond} />
      )
    ) : item.type === "short-text" ? (
      <ShortTextItem item={item} mode={mode} respond={respond} />
    ) : item.type === "multiple-choice" ? (
      <MultipleChoiceItem item={item} mode={mode} respond={respond} />
    ) : item.type === "multi-select" ? (
      <MultiSelectItem item={item} mode={mode} respond={respond} />
    ) : null;

  return (
    <div className="font-sans flex flex-col gap-3">
      <MetaPills item={item} />
      {item.stem?.leadIn && <p className="text-xs italic text-zinc-500">{item.stem.leadIn}</p>}
      {body}
      {mode === "review" && (
        <>
          <ReviewPanel item={item} />
          <Warnings warnings={item.warnings ?? []} />
        </>
      )}
    </div>
  );
}
