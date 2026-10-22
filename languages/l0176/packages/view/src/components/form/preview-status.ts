// SPDX-License-Identifier: MIT
// Tells an embedding host whether the assessment actually came up.
//
// The shared View posts `onload` and `data-updated` to the parent on mount,
// before the task has loaded or Learnosity has initialized, so neither says
// the preview works. A host that frames this page (the MCP widget) needs to
// know that, to fall back to its own rendering when it doesn't. The Form is
// the only place that sees Learnosity's ready and error callbacks, so it
// reports the outcome itself:
//
//   { type: "preview-ready" }             Learnosity's readyListener fired
//   { type: "preview-error", reason }     it never will: compile errors, an
//                                         unsigned preview, the SDK script
//                                         failed, or Learnosity reported an
//                                         error
//
// Posted only when the page was given an `origin` (the View's targetOrigin
// param), to exactly that origin and never "*", and at most once per mount:
// the first outcome is the answer. Hosts that pass no origin see nothing new.

export type PreviewStatus = { type: "preview-ready" } | { type: "preview-error"; reason: string };

/** The `origin` search param, when it is a bare origin; otherwise null. */
export function previewTargetOrigin(search: string = window.location.search): string | null {
  const raw = new URLSearchParams(search).get("origin");
  if (!raw) return null;
  try {
    const { origin } = new URL(raw);
    return origin === raw ? origin : null;
  } catch {
    return null;
  }
}

/** A poster that sends the first status it is given, and ignores the rest. */
export function createPreviewStatus(
  targetOrigin: string | null = previewTargetOrigin(),
  target: { postMessage: (message: unknown, targetOrigin: string) => void } | null =
    window.parent !== window ? window.parent : null,
): (status: PreviewStatus) => void {
  let sent = false;
  return (status) => {
    if (sent || !targetOrigin || !target) return;
    sent = true;
    target.postMessage(status, targetOrigin);
  };
}
