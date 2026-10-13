// SPDX-License-Identifier: MIT
/**
 * L0180's Form: renders one compiled assessment item, or the compile errors that stopped it.
 *
 * Injected into the shared View from @graffiticode/l0000-view, which supplies `state.data`,
 * `state.errors` and `state.apply`, and owns the URL params, the parent-window messaging and
 * the recompile loop. This file only renders and reports.
 *
 * A selection is reported as a `response` action because that is one of the two action types
 * the shared View recompiles on — so scoring needs no transport of its own. The item comes
 * back with the response attached, which is what lets a graded delivery withhold `validation`
 * and score on the server instead.
 */
import "../../index.css";
import type { FormProps, CompileError } from "@graffiticode/l0000-view";
import { InteractionView } from "./interactions";
import { ItemView } from "./ItemView";
import { ActivityView } from "./ActivityView";
import { ErrorList } from "./itemKit";

export const Form = ({ state }: FormProps) => {
  const errors: CompileError[] = state.errors ?? [];
  const data = state.data ?? {};
  const interaction = data.interaction;
  const activity = data.activity;

  const body = () => {
    if (errors.length > 0) return <ErrorList errors={errors} />;
    const respond = (response: unknown) =>
      state.apply({ type: "response", args: { response } });

    // An activity is the other whole-program shape: several items rather than one. Checked
    // first because a program is one or the other, never both.
    if (activity) {
      return <ActivityView activity={activity} response={data.response} respond={respond} />;
    }
    if (!interaction) {
      // Nothing compiled yet, or a program that produced something other than an item.
      return <pre className="text-xs text-zinc-500">{JSON.stringify(data, null, 2)}</pre>;
    }
    // A multi-part item owns its own parts and their response keying; anything else is a bare
    // interaction and goes straight to the registry.
    if (interaction.type === "item") {
      return (
        <ItemView
          interaction={interaction}
          validation={data.validation}
          response={data.response}
          respond={respond}
        />
      );
    }
    return (
      <InteractionView
        interaction={interaction}
        validation={data.validation}
        response={data.response}
        respond={respond}
      />
    );
  };

  return <div className="l0180-item bg-white text-zinc-900 rounded-md font-sans p-4">{body()}</div>;
};
