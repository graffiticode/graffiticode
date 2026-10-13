// SPDX-License-Identifier: MIT
/**
 * The stack picker: which slice of the deck to study.
 *
 * A native <select> rather than a headless listbox. It is keyboard- and screen-reader-correct
 * for free, it opens as the platform expects on a phone, and it keeps two npm dependencies
 * out of a published component — L0159 pulled in @headlessui/react and @heroicons/react for
 * this one control.
 */
import type { Stack, StackDef } from "../../lib/marks";

export function StackMenu({
  stacks,
  value,
  counts,
  onChange,
}: {
  stacks: StackDef[];
  value: Stack;
  counts: Record<Stack, number>;
  onChange: (stack: Stack) => void;
}) {
  const current = stacks.find((s) => s.id === value) ?? stacks[0];
  return (
    <label className="flex items-center gap-2 text-xs">
      <span aria-hidden="true" className={`h-3 w-3 shrink-0 rounded-full ${current.dot}`} />
      <span className="sr-only">Card stack</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Stack)}
        className="appearance-none rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
      >
        {stacks.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label} ({counts[s.id]})
          </option>
        ))}
      </select>
    </label>
  );
}
