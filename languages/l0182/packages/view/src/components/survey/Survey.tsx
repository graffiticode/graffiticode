// SPDX-License-Identifier: MIT
/**
 * L0182's view: the compiled record, rendered.
 *
 * It is READ-ONLY, and that is the design rather than a stage it is at. There is no survey flow
 * in this language — no screens, no steps, nothing to submit — because the code IS the
 * interface: a person edits the program in the console's editor, an agent edits it through
 * `update_item`, and both produce the same record. Adding a control here would create a third
 * way to answer that neither of them shares.
 *
 * The survey's style decides the body. A ranked-choice survey is two columns, a before/after of
 * one pass: left is the set of options as it was drawn, right is what came back — the choices in
 * priority order, and the write-in. Options that were chosen are dimmed on the left rather than
 * removed, so the column keeps its shape and what was passed over stays visible. A rating survey
 * (`Rating.tsx`) is one row per item with its scale laid out and the answer marked on it.
 *
 * Injected into the shared View from @graffiticode/l0000-view, which supplies `state.data` and
 * `state.errors`. It takes no `apply`: nothing here writes.
 */
import "../../index.css";
import type { FormProps, CompileError } from "@graffiticode/l0000-view";
import { boundsLabel, isRating, resolveChoices } from "../../lib/survey";
import type { Compiled, RankedResponse, RankedSurvey, RatingResponse } from "../../lib/survey";
import { Empty, ErrorList, OptionRow, Panel } from "./kit";
import { RatingBody } from "./Rating";

export const Survey = ({ state }: FormProps) => {
  const compileErrors: CompileError[] = state.errors ?? [];
  const data: Compiled = state.data ?? {};
  const { survey, response } = data;

  if (compileErrors.length) {
    return (
      <div className="l0182-survey mx-auto max-w-4xl p-6">
        <ErrorList errors={compileErrors} />
      </div>
    );
  }

  if (
    !survey ||
    !(isRating(survey) ? Array.isArray(survey.items) : Array.isArray(survey.options))
  ) {
    return (
      <div className="l0182-survey mx-auto max-w-4xl p-6">
        <Empty>Nothing to show yet — this program has not compiled a survey.</Empty>
      </div>
    );
  }

  return (
    <div className="l0182-survey mx-auto flex max-w-4xl flex-col gap-6 p-6">
      {/* Title, then the survey's own words, then — as the caption on the options panel — the
          bounds line derived from minChoices/maxChoices. `id`, `sessionId` and `instance` are
          deliberately absent: they are the handles a response is keyed by, not something a
          participant should read, and while the id sat here it occupied the line the
          instructions belong on. */}
      <header className="flex flex-col gap-2">
        {survey.title && <h1 className="text-lg font-semibold text-zinc-900">{survey.title}</h1>}
        <p className="whitespace-pre-line text-sm text-zinc-600">{survey.instructions}</p>
      </header>

      {isRating(survey) ? (
        <RatingBody survey={survey} response={response as RatingResponse | undefined} />
      ) : (
        <RankedBody survey={survey} response={response as RankedResponse | undefined} />
      )}
    </div>
  );
};

/**
 * A ranked-choice survey: the set on the left, what came back on the right.
 */
function RankedBody({ survey, response }: { survey: RankedSurvey; response?: RankedResponse }) {
  const { chosen, unknown, chosenIds } = resolveChoices(survey, response);
  const answered = !!response;

  // One column on a phone. This is published as an embed and renders inside other people's
  // pages, so the layout cannot assume it has the width for two.
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Panel heading="The options" caption={boundsLabel(survey)}>
        <ul className="flex flex-col gap-2">
          {survey.options.map((option) => (
            <li key={option.id}>
              <OptionRow text={option.text} muted={chosenIds.has(option.id)} />
            </li>
          ))}
        </ul>
      </Panel>

      <Panel
        heading="The response"
        caption={
          answered
            ? chosen.length
              ? `${chosen.length} chosen, most important first`
              : "Nothing chosen"
            : undefined
        }
      >
        {!answered ? (
          <Empty>No response yet.</Empty>
        ) : (
          <div className="flex flex-col gap-4">
            {chosen.length > 0 && (
              <ol className="flex flex-col gap-2">
                {chosen.map((option, i) => (
                  <li key={option.id}>
                    <OptionRow
                      text={option.text}
                      accent
                      badge={
                        <span className="text-sm font-semibold tabular-nums text-green-700">
                          {i + 1}
                        </span>
                      }
                    />
                  </li>
                ))}
              </ol>
            )}

            {/* The compiler refuses these, so they only reach here on a record assembled
                outside it. Named rather than dropped: a shorter ranking than the one recorded
                is the kind of wrong that looks right. */}
            {unknown.length > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                {unknown.length === 1 ? "This id names" : "These ids name"} nothing in the set:{" "}
                {unknown.join(", ")}.
              </div>
            )}

            {response?.writeIn && (
              <div className="flex flex-col gap-1.5 border-t border-zinc-200 pt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                  Write-in — not in the set
                </p>
                <p className="text-[15px] leading-relaxed text-zinc-800">{response.writeIn}</p>
              </div>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
