// SPDX-License-Identifier: MIT
/**
 * The hottext interaction: a passage whose sentences or words are clickable.
 *
 * Deliberately two components rather than one with a mode flag. A hottext that selects
 * `within "stimulus"` owns the item's passage, and the passage has to render at the TOP of the
 * item — above Part A — while the interaction's own prompt belongs down in its part slot. So
 * `ItemView` places `HottextPassage` in the stimulus slot and `HottextPrompt` in the part slot,
 * and `HottextItem` stacks both for a hottext standing on its own.
 *
 * L0175 renders the passage twice — once read-only, once clickable — and gets away with it
 * because those live in separate tabs. L0180 lays stimulus and parts out inline, so the same
 * approach would put the passage on screen twice.
 */
import { Fragment } from "react";
import { cx, ResultBanner, Stem } from "./itemKit";
import { correctIds, scoreChoice, selectedIds } from "../../scoring";
import type { Validation } from "../../scoring";

interface Unit {
  id: string;
  text: string;
  pre?: string;
  post?: string;
  selectable: boolean;
}

interface Interaction {
  type: string;
  prompt?: string;
  granularity?: "sentence" | "word";
  within?: string;
  minChoices?: number;
  maxChoices?: number;
  units?: Unit[];
}

interface Props {
  interaction: Interaction;
  /** Absent when the item is delivered graded — the key stays server-side and no feedback shows. */
  validation?: Validation;
  response: unknown;
  respond: (response: string[]) => void;
  showResult?: boolean;
}

/** Everything both halves need, derived once so they cannot disagree. */
function useOutcome(interaction: Interaction, validation: Validation | undefined, response: unknown) {
  const selected = selectedIds(response);
  const gradable = !!validation && (validation.points ?? 0) > 0;
  return {
    selected,
    max: interaction.maxChoices ?? 1,
    correct: new Set(correctIds(validation)),
    feedback: validation?.feedback ?? {},
    showFeedback: gradable && selected.length > 0,
  };
}

/** Group sentence units by the paragraph in their id — `p2.1` and `p2.2` belong together. */
function byParagraph(units: Unit[]): { key: string; units: Unit[] }[] {
  const out: { key: string; units: Unit[] }[] = [];
  for (const u of units) {
    const key = u.id.includes(".") ? u.id.slice(0, u.id.lastIndexOf(".")) : "";
    const last = out[out.length - 1];
    if (last && last.key === key) last.units.push(u);
    else out.push({ key, units: [u] });
  }
  return out;
}

/**
 * The clickable text.
 *
 * At the ceiling a further click is refused rather than evicting the oldest selection, which is
 * where this differs from `ChoiceItem`. In a list of options an eviction is visible; in a
 * passage the displaced sentence may be paragraphs away and off screen, so the candidate would
 * watch one selection vanish for no stated reason.
 */
export function HottextPassage({ interaction, validation, response, respond }: Props) {
  const units = interaction.units ?? [];
  const { selected, max, correct, showFeedback } = useOutcome(interaction, validation, response);
  const word = interaction.granularity === "word";

  const toggle = (id: string) => {
    if (selected.includes(id)) {
      respond(selected.filter((s) => s !== id));
      return;
    }
    if (selected.length >= max) return;
    respond([...selected, id]);
  };

  const unitClass = (u: Unit) => {
    const on = selected.includes(u.id);
    const right = showFeedback && on && correct.has(u.id);
    const wrong = showFeedback && on && !correct.has(u.id);
    return cx(
      "rounded px-1 cursor-pointer border transition",
      word && "underline decoration-dotted underline-offset-2",
      right
        ? "border-green-400 bg-green-50"
        : wrong
          ? "border-red-400 bg-red-50"
          : on
            ? "border-blue-400 bg-blue-50"
            : "border-zinc-300 bg-white hover:bg-zinc-100",
    );
  };

  const mark = (u: Unit) => {
    const on = selected.includes(u.id);
    if (!showFeedback || !on) return null;
    return (
      <span aria-hidden="true" className="ml-1">
        {correct.has(u.id) ? "✓" : "✗"}
      </span>
    );
  };

  const clickable = (u: Unit) => (
    <span
      role="button"
      tabIndex={0}
      aria-pressed={selected.includes(u.id)}
      onClick={() => toggle(u.id)}
      onKeyDown={(e) => {
        // A span is not a button, so Enter and Space have to be wired by hand — the native
        // inputs in `OptionRow` get this for free and these do not.
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle(u.id);
        }
      }}
      // Without this a sentence wrapping across lines gets its border drawn only on the
      // first fragment, so a long selection looks broken.
      style={{ WebkitBoxDecorationBreak: "clone", boxDecorationBreak: "clone" }}
      className={unitClass(u)}
    >
      {u.text}
      {mark(u)}
    </span>
  );

  const render = (u: Unit) =>
    u.selectable ? (
      <Fragment key={u.id}>
        {u.pre}
        {clickable(u)}
        {u.post}{" "}
      </Fragment>
    ) : (
      <Fragment key={u.id}>{`${u.pre ?? ""}${u.text}${u.post ?? ""} `}</Fragment>
    );

  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
      {word ? (
        <p className="text-sm text-zinc-800 leading-loose m-0">{units.map(render)}</p>
      ) : (
        <ol className="flex flex-col gap-1 list-none p-0 m-0">
          {byParagraph(units).map((p, i) => (
            <li key={p.key || i} className="flex gap-3 text-sm text-zinc-800 leading-loose">
              {/* Numbered as the static stimulus is, so a stem can still cite a line. */}
              <span className="text-zinc-400 tabular-nums select-none w-5 text-right">{i + 1}</span>
              <span className="flex-1">{p.units.map(render)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * The stem, the count, the rationales and the score — everything about the interaction that is
 * not the passage itself.
 */
export function HottextPrompt({ interaction, validation, response, showResult = true }: Props) {
  const { selected, max, correct, feedback, showFeedback } = useOutcome(interaction, validation, response);
  const min = interaction.minChoices ?? 0;
  const score = showFeedback && showResult ? scoreChoice({ response: selected, validation }) : null;

  // Only against something the candidate actually picked, so an untouched unit is never
  // explained — the same rule `OptionRow` follows.
  const explained = showFeedback
    ? selected.filter((id) => feedback[id] && !correct.has(id))
    : [];

  return (
    <div className="flex flex-col gap-2">
      {interaction.prompt && (
        <fieldset className="border-0 p-0 m-0">
          <Stem>{interaction.prompt}</Stem>
        </fieldset>
      )}
      {max > 1 && (
        <p className="text-xs text-zinc-500">
          {min === max ? `Select exactly ${max}.` : `Select up to ${max}.`}
          {selected.length > 0 && ` ${selected.length} selected.`}
        </p>
      )}
      {explained.map((id) => (
        <p key={id} className="text-xs text-red-800 m-0">
          {feedback[id]}
        </p>
      ))}
      {score && (
        <ResultBanner correct={score.correct}>
          {score.correct
            ? `Correct — ${score.points} / ${score.maxPoints} ${score.maxPoints === 1 ? "point" : "points"}.`
            : `Not quite — ${score.points} / ${score.maxPoints} ${score.maxPoints === 1 ? "point" : "points"}.`}
        </ResultBanner>
      )}
    </div>
  );
}

/** A hottext standing on its own: its stem, then its passage. */
export function HottextItem(props: Props) {
  return (
    <div className="flex flex-col gap-3">
      <HottextPrompt {...props} />
      <HottextPassage {...props} />
    </div>
  );
}
