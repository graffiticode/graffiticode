// SPDX-License-Identifier: MIT
/**
 * A rating survey, rendered: one row per item, its scale laid out as points with the answer
 * marked on it.
 *
 * Read-only, like the rest of the view. A point is a `<span>`, not a control — the answer is
 * written as code, and a scale drawn as buttons would promise an interaction that does not exist.
 *
 * Where the ranked-choice view is two columns, before and after, this is one: a scale shows both
 * at once, every point it offered with the one chosen filled in. An unanswered item keeps its
 * points and says so, so a partly answered survey reads as partly answered rather than short.
 */
import type { RatedItem, Rating, RatingResponse, RatingSurvey } from "../../lib/survey";
import { answerText, resolveRatings, scaleEnds } from "../../lib/survey";
import { cx, Empty, Panel } from "./kit";

/** One point on a scale. Labelled points read as words; bare ones as their value. */
function Point({ text, chosen }: { text: string; chosen: boolean }) {
  return (
    <span
      className={cx(
        "inline-flex min-w-[2.25rem] items-center justify-center rounded-md border px-2 py-1 text-sm tabular-nums",
        chosen
          ? "border-green-600 bg-green-600 font-semibold text-white"
          : "border-zinc-200 bg-white text-zinc-600",
      )}
      aria-current={chosen ? "true" : undefined}
    >
      {text}
    </span>
  );
}

/** A star scale: filled up to the answer. */
function Stars({ item, answer }: { item: RatedItem; answer?: Rating }) {
  const value = answer && "value" in answer ? answer.value : undefined;
  return (
    <span
      className="text-xl tracking-wider"
      aria-label={value !== undefined ? `${value} stars` : "no answer"}
    >
      {item.scale.points.map((p) => (
        <span
          key={p.value}
          className={value !== undefined && p.value <= value ? "text-amber-500" : "text-zinc-300"}
        >
          ★
        </span>
      ))}
    </span>
  );
}

function Scale({ item, answer }: { item: RatedItem; answer?: Rating }) {
  const { points, optOut, display } = item.scale;
  const [low, high] = scaleEnds(item);
  const labelled = points.every((p) => p.label);
  const optedOut = !!answer && "optOut" in answer;
  const value = answer && "value" in answer ? answer.value : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      {display === "stars" ? (
        <Stars item={item} answer={answer} />
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {points.map((p) => (
            <Point
              key={p.value}
              text={labelled ? p.label! : String(p.value)}
              chosen={p.value === value}
            />
          ))}
          {optOut && <Point text={optOut} chosen={optedOut} />}
        </div>
      )}
      {/* End words under a numeric scale — the scale's own, or the item's pair when it is a
          semantic differential. A labelled scale already says them on its points. */}
      {!labelled && (low || high) && (
        <div className="flex justify-between gap-4 text-xs text-zinc-500">
          <span>{low && `${points[0].value} = ${low}`}</span>
          <span className="text-right">
            {high && `${points[points.length - 1].value} = ${high}`}
          </span>
        </div>
      )}
    </div>
  );
}

/** The line under an item: its answer in words, or why it has none. */
function status(item: RatedItem, answer: Rating | undefined, answeredYet: boolean): string {
  if (answer) return answerText(item, answer);
  if (answeredYet) return item.required ? "Not answered" : "Not answered — optional";
  return item.required ? "" : "Optional";
}

export function RatingBody({
  survey,
  response,
}: {
  survey: RatingSurvey;
  response?: RatingResponse;
}) {
  const { rows, answered, unknown } = resolveRatings(survey, response);
  const answeredYet = !!response;
  const required = survey.items.filter((x) => x.required).length;

  return (
    <div className="flex flex-col gap-6">
      <Panel
        heading="The items"
        caption={
          answeredYet
            ? `${answered} of ${rows.length} answered`
            : `No response yet — ${required === rows.length ? "every item is required" : `${required} of ${rows.length} required`}`
        }
      >
        <ol className="flex flex-col gap-3">
          {rows.map(({ item, answer }) => (
            <li
              key={item.id}
              className="grid gap-3 rounded-md border border-zinc-200 bg-white px-4 py-3 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:items-start"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <p className="break-words text-[15px] text-zinc-900">{item.text}</p>
                <p className="text-xs text-zinc-500">{status(item, answer, answeredYet)}</p>
              </div>
              <Scale item={item} answer={answer} />
            </li>
          ))}
        </ol>

        {/* The compiler refuses these, so they only reach here on a record assembled outside it.
            Named rather than dropped, as for `choices`. */}
        {unknown.length > 0 && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            {unknown.length === 1 ? "This rating fits" : "These ratings fit"} nothing in the survey:{" "}
            {unknown.map((r) => `${r.item} → ${"optOut" in r ? "opt-out" : r.value}`).join(", ")}.
          </div>
        )}
      </Panel>

      {survey.comment && (
        <Panel heading="Comment" caption={survey.comment.prompt}>
          {response?.comment ? (
            <p className="whitespace-pre-line text-[15px] leading-relaxed text-zinc-800">
              {response.comment}
            </p>
          ) : (
            <Empty>{answeredYet ? "No comment." : "No response yet."}</Empty>
          )}
        </Panel>
      )}
    </div>
  );
}
