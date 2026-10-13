// SPDX-License-Identifier: MIT
/** The shared furniture: one panel, one row, one error list. */
import type { ReactNode } from "react";

export function cx(...c: unknown[]): string {
  return c.filter(Boolean).join(" ");
}

export function ErrorList({ errors }: { errors: { message: string }[] }) {
  return (
    <div className="flex flex-col gap-2">
      {errors.map((e, i) => (
        <div
          key={i}
          className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          {e.message}
        </div>
      ))}
    </div>
  );
}

/** One column: a heading, a quiet caption under it, and whatever it holds. */
export function Panel({
  heading,
  caption,
  children,
}: {
  heading: string;
  caption?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{heading}</h2>
        {caption && <p className="text-sm text-zinc-500">{caption}</p>}
      </div>
      {children}
    </section>
  );
}

/**
 * One option, as a row.
 *
 * Not a button. Nothing here is interactive — the record is edited as code — so rendering these
 * as controls would announce them to a screen reader as things to press and promise an
 * interaction that does not exist.
 */
export function OptionRow({
  text,
  badge,
  muted,
  accent,
}: {
  text: string;
  badge?: ReactNode;
  /** Shown, but not the point of this column. */
  muted?: boolean;
  accent?: boolean;
}) {
  return (
    <div
      className={cx(
        "flex w-full items-start gap-3 rounded-md border px-4 py-3 text-left text-[15px]",
        accent ? "border-green-600 bg-green-50 text-green-900" : "border-zinc-200 bg-white",
        muted && "opacity-50",
      )}
    >
      {badge !== undefined && (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center">{badge}</span>
      )}
      <span className="min-w-0 flex-1 break-words">{text}</span>
    </div>
  );
}

/** What a column says when it has nothing in it — a state, not a failure. */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-500">
      {children}
    </div>
  );
}
