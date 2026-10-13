// SPDX-License-Identifier: MIT
/**
 * L0183's reducer case, passed to the shared View as `reduce`.
 *
 * A placement is reported as `{type: "response", args: {cells: {n3: {value: "Receptor"}}}}` —
 * the shape `@graffiticode/learnosity-cqt` uses, so the Form speaks one protocol in both hosts.
 * The shared View's generic `response` merges `args` onto the TOP level, which would write a
 * `cells` key nothing reads while `interaction.cells` stayed stale; the recompile would then
 * carry no answers back and the placement would vanish. So a response is merged into
 * `interaction.cells` here, per cell. `response` still recompiles: the shared View decides that
 * by action type, whoever reduced it.
 *
 * Everything else falls through (`undefined`) to the shared View.
 */
import type { LanguageReducer, StateAction } from "@graffiticode/l0000-view";

export const reduce: LanguageReducer = (data: any, { type, args }: StateAction) => {
  if (type !== "response" || !args?.cells || !data?.interaction) return undefined;
  const cells = { ...(data.interaction.cells || {}) };
  for (const id of Object.keys(args.cells)) {
    const value = args.cells[id]?.value;
    cells[id] = typeof value === "string" ? { value } : {};
  }
  return { ...data, interaction: { ...data.interaction, cells } };
};
