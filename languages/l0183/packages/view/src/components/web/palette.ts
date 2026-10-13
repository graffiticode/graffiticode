// SPDX-License-Identifier: MIT
/**
 * Node colours as literal Tailwind classes. They are spelled out rather than built from the
 * colour name because Tailwind finds classes by scanning source text: `bg-${color}-100` would
 * never be generated, and every coloured node would render with no fill at all.
 *
 * L0169 kept its own hex table instead, and it drifted (`blue-900` was `#1e3a5f`).
 */
export const NODE_COLORS: Record<string, string> = {
  gray: "bg-zinc-100 border-zinc-400 text-zinc-900 dark:bg-zinc-800 dark:border-zinc-500 dark:text-zinc-100",
  red: "bg-red-100 border-red-400 text-red-950 dark:bg-red-950 dark:border-red-500 dark:text-red-100",
  orange:
    "bg-orange-100 border-orange-400 text-orange-950 dark:bg-orange-950 dark:border-orange-500 dark:text-orange-100",
  amber:
    "bg-amber-100 border-amber-400 text-amber-950 dark:bg-amber-950 dark:border-amber-500 dark:text-amber-100",
  yellow:
    "bg-yellow-100 border-yellow-400 text-yellow-950 dark:bg-yellow-950 dark:border-yellow-500 dark:text-yellow-100",
  green:
    "bg-green-100 border-green-500 text-green-950 dark:bg-green-950 dark:border-green-500 dark:text-green-100",
  teal: "bg-teal-100 border-teal-500 text-teal-950 dark:bg-teal-950 dark:border-teal-500 dark:text-teal-100",
  blue: "bg-blue-100 border-blue-400 text-blue-950 dark:bg-blue-950 dark:border-blue-500 dark:text-blue-100",
  indigo:
    "bg-indigo-100 border-indigo-400 text-indigo-950 dark:bg-indigo-950 dark:border-indigo-500 dark:text-indigo-100",
  purple:
    "bg-purple-100 border-purple-400 text-purple-950 dark:bg-purple-950 dark:border-purple-500 dark:text-purple-100",
  pink: "bg-pink-100 border-pink-400 text-pink-950 dark:bg-pink-950 dark:border-pink-500 dark:text-pink-100",
};

/** A node with no colour of its own. */
export const NODE_DEFAULT =
  "bg-white border-zinc-300 text-zinc-900 dark:bg-zinc-800 dark:border-zinc-600 dark:text-zinc-100";

/** The hub, when it has no colour of its own, stands out from the ring. */
export const HUB_DEFAULT =
  "bg-zinc-800 border-zinc-800 text-white dark:bg-zinc-100 dark:border-zinc-100 dark:text-zinc-900";

/** Feedback overrides a node's own colour: right and wrong must read the same everywhere. */
export const RIGHT =
  "bg-green-100 border-green-600 text-green-950 dark:bg-green-900 dark:border-green-400 dark:text-green-50";
export const WRONG =
  "bg-red-100 border-red-600 text-red-950 dark:bg-red-900 dark:border-red-400 dark:text-red-50";

export const SHAPE_CLASS: Record<string, string> = {
  rounded: "rounded-xl",
  rect: "rounded-none",
  pill: "rounded-full",
  circle: "rounded-full",
};
