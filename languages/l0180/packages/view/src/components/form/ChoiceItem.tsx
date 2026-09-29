// SPDX-License-Identifier: MIT
/**
 * The choice interaction: a stem and a list of options, single- or multi-select.
 *
 * The component owns no answer state of its own. A selection is reported through
 * `respond`, lands in the data model as `response`, and comes back down as a prop — so the
 * rendered selection is always the model's, not a local copy that can drift from it. This is
 * what `formModel: "live"` means, and it is why L0180 does not need L0166's `"loaded"` escape
 * hatch.
 */
import { useId } from "react";
import { OptionRow, ResultBanner, Stem } from "./itemKit";
import { useShuffled } from "./shuffling";
import { correctIds, scoreChoice, selectedIds } from "../../scoring";
import type { Validation } from "../../scoring";

interface Option {
  id: string;
  text?: string;
  /** Set by the compiler on an option that stays last however the rest is shuffled. */
  anchored?: boolean;
}

interface Interaction {
  type: string;
  prompt?: string;
  minChoices?: number;
  maxChoices?: number;
  shuffle?: boolean;
  options?: Option[];
}


/**
 * "Select exactly 2" when the floor and the ceiling agree, which is what an exact-set item
 * asks for. Reading the two constraints back separately produced "Select up to 2, at least 2".
 */
function selectionHint(interaction: Interaction): string {
  const max = interaction.maxChoices ?? 1;
  const min = interaction.minChoices ?? 0;
  if (min === max) return `Select exactly ${min}.`;
  return min > 0 ? `Select up to ${max}, at least ${min}.` : `Select up to ${max}.`;
}

export function ChoiceItem({
  interaction,
  validation,
  response,
  respond,
  showResult = true,
}: {
  interaction: Interaction;
  /** Absent when the item is delivered graded — the key stays server-side and no feedback shows. */
  validation?: Validation;
  response: unknown;
  respond: (response: string[]) => void;
  /**
   * Whether this interaction reports its own score. False when it is a part inside an item:
   * under conjunctive scoring a per-part "Correct" while the item earns nothing is actively
   * misleading, so only the item reports. Option-level marks still show either way.
   */
  showResult?: boolean;
}) {
  // Radios in one native group are mutually exclusive, so every choice on the page needs its
  // own group name. A fixed one put both parts of a two-part item in the same group, and the
  // browser silently unchecked Part A when Part B was answered.
  const group = useId();
  const options = interaction.options ?? [];
  const maxChoices = interaction.maxChoices ?? 1;
  const multiple = maxChoices > 1;
  const ordered = useShuffled(options, interaction.shuffle === true);
  const selected = selectedIds(response);

  const toggle = (id: string) => {
    if (!multiple) {
      respond([id]);
      return;
    }
    if (selected.includes(id)) {
      respond(selected.filter((s) => s !== id));
      return;
    }
    // Hold the author's ceiling rather than silently dropping the click: at the limit, the
    // oldest selection makes way. Refusing outright leaves the learner with no feedback at all.
    const next = [...selected, id];
    respond(next.length > maxChoices ? next.slice(next.length - maxChoices) : next);
  };

  const gradable = !!validation && (validation.points ?? 0) > 0;
  const answered = selected.length > 0;
  const showFeedback = gradable && answered;
  const score = showFeedback && showResult ? scoreChoice({ response: selected, validation }) : null;
  // Via `correctIds` rather than reaching into the key, so this and the scorer cannot disagree
  // about which options are right under one template but not the other.
  const correct = new Set(correctIds(validation));
  const feedback = validation?.feedback ?? {};

  return (
    <div className="flex flex-col gap-3">
      <fieldset className="border-0 p-0 m-0">
        {interaction.prompt && <Stem>{interaction.prompt}</Stem>}
        <div className="flex flex-col gap-2">
          {ordered.map((o) => (
            <OptionRow
              key={o.id}
              name={group}
              id={o.id}
              multiple={multiple}
              selected={selected.includes(o.id)}
              onSelect={() => toggle(o.id)}
              feedback={showFeedback}
              correct={correct.has(o.id)}
              rationale={feedback[o.id]}
            >
              {o.text}
            </OptionRow>
          ))}
        </div>
      </fieldset>
      {multiple && <p className="text-xs text-zinc-500">{selectionHint(interaction)}</p>}
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
