// SPDX-License-Identifier: MIT
// L0176's Form: renders a Learnosity assessment by dynamically loading the
// matching Learnosity browser SDK (questions / items) and mounting the
// signed request. Ported from L0158's Form.tsx, adapted to the shared View's
// FormProps contract (state.data / state.errors) — the View (from
// @graffiticode/l0000-view) owns the iframe postMessage/onload protocol. The
// Form adds one thing to it: whether Learnosity actually came up
// (`preview-ready` / `preview-error`, preview-status.ts), which only it can
// see.
//
// Resolve, then sign (ported from L0158's View). The compiled data is a
// `{ type, data }` activity, signed at compile time (an L0176 item) or not
// (an L0158 item, which renders here since L0158 holds no credential):
//   - one row of its `dynamic_content_data` is picked per mount and
//     substituted everywhere, custom-question data included (resolve.ts);
//   - when the activity has no `request`, or it is a `questions` activity
//     substitution changed, the resolved activity is signed through the api's
//     `POST /preview/sign` (sign.ts; the api compiles L0176's `init data {}`)
//     and rendered as `{ type: activity.type, request }`;
//   - any other already-signed activity (one with nothing to substitute, and
//     every signed `items` activity) renders its own request directly, with
//     no second compile.
// Without a request (signing unavailable, busy, or still pending) the
// Learnosity SDK is never initialized; an unsigned preview shows why.
import "../../index.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormProps, CompileError } from "@graffiticode/l0000-view";
import { contentKey } from "./contentKey";
import { activityKey, isActivity, pickRow, resolveVariables } from "./resolve";
import { signActivity, UNSIGNED_MESSAGE } from "./sign";
import type { SignResult } from "./sign";
import { createPreviewStatus } from "./preview-status";

function renderErrors(errors: CompileError[]) {
  return (
    <div className="flex flex-col gap-2">
      {errors.map((error, i) => (
        <div
          key={i}
          className="rounded-md p-3 border text-sm bg-red-50 border-red-200 text-red-800"
        >
          {error.message}
        </div>
      ))}
    </div>
  );
}

interface Renderable {
  type?: string;
  request?: any;
  /** A signing compile is in flight for the current content. */
  pending: boolean;
  /** Why there is no request, when there is none. */
  message?: string;
  errors: CompileError[];
}

// What to render for the compiled data: its own request, or the request
// signed for its resolved content.
function useRenderable(data: any): Renderable {
  const activity = isActivity(data) ? data : null;
  const key = activity ? activityKey(activity) : null;
  // One row per mount; picked again only if the table itself changes.
  const table = JSON.stringify(activity?.data?.dynamic_content_data ?? null);
  const env = useMemo(() => (activity ? pickRow(activity.data.dynamic_content_data) : null), [table]);
  const resolved = useMemo(() => {
    if (!activity) return null;
    if (!env) return { activity, changed: false };
    const out = resolveVariables({ type: activity.type, data: activity.data }, env);
    return { activity: out, changed: JSON.stringify(out.data) !== JSON.stringify(activity.data) };
  }, [key, env]);
  // The sign compile runs under the SYSTEM preview session, a different
  // Learnosity consumer from a user's connection. Inline questions sign the
  // same under any consumer, but an items activity may load bank items by
  // reference the system consumer can't see. So an already-signed items
  // activity is never re-signed, dynamic data or not (Learnosity still
  // substitutes its standard fields); only an already-signed questions
  // activity whose substitution changed it is.
  const needsSign = Boolean(
    resolved && (!activity.request || (activity.type === "questions" && resolved.changed)),
  );
  // Keyed on the RESOLVED content, so the same content is signed once
  // whatever the identity of the data the host hands down.
  const signKey = needsSign ? activityKey(resolved.activity) : null;
  const [signed, setSigned] = useState<{ key: string; result: SignResult } | null>(null);
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;

  useEffect(() => {
    if (!signKey) return;
    let cancelled = false;
    signActivity(resolvedRef.current.activity).then((result) => {
      if (!cancelled) setSigned({ key: signKey, result });
    });
    return () => {
      cancelled = true;
    };
  }, [signKey]);

  if (!activity) {
    return { type: data?.type, request: data?.request, pending: false, message: data?.signing?.message, errors: [] };
  }
  if (!needsSign) {
    return { type: activity.type, request: activity.request, pending: false, errors: [] };
  }
  const result = signed?.key === signKey ? signed.result : null;
  return {
    type: activity.type,
    request: result?.request,
    pending: !result,
    message: result?.message,
    errors: result?.errors ?? [],
  };
}

export const Form = ({ state }: FormProps) => {
  const { type, request, pending, message, errors: signErrors } = useRenderable(state.data);
  const errors: CompileError[] = [...(state.errors ?? []), ...signErrors];
  const hasErrors = errors.length > 0;
  const hasRequest = Boolean(request);
  const [scriptLoaded, setScriptLoaded] = useState(false);
  // The content key of the assessment currently mounted into Learnosity. Guards
  // against the host's re-signed-request churn re-initializing the SDK (see
  // contentKey above).
  const initedContentRef = useRef<string | null>(null);
  // One outcome per mount, to the embedding host that asked for it.
  const [postStatus] = useState(() => createPreviewStatus());
  const unsigned = (type === "questions" || type === "items") && !request && !pending;
  // Compiled data that isn't a Learnosity activity (a bare program's value).
  // An empty record is the View's pre-load state, not an answer.
  const loaded = state.data != null && !(typeof state.data === "object" && Object.keys(state.data).length === 0);
  const notAnActivity = loaded && type !== "questions" && type !== "items";

  useEffect(() => {
    if (hasErrors) postStatus({ type: "preview-error", reason: "compile-errors" });
    else if (unsigned) postStatus({ type: "preview-error", reason: `unsigned: ${message || UNSIGNED_MESSAGE}` });
    else if (notAnActivity) postStatus({ type: "preview-error", reason: "not-an-activity" });
  }, [hasErrors, unsigned, notAnActivity, message]);

  useEffect(() => {
    if (hasErrors) return;
    if (!type || !hasRequest) return;
    // Dynamically load the Learnosity script for this result type. Re-run on
    // type change so preview (questions) and save (items) swap scripts
    // correctly when state.data.type flips post-compile.
    setScriptLoaded(false);
    const script = document.createElement("script");
    script.src =
      type === "questions" ? "https://questions.learnosity.com/?latest-lts" :
      "https://items.learnosity.com/?latest-lts";
    script.async = true;
    script.onload = () => setScriptLoaded(true);
    script.onerror = (e) => {
      console.error("Learnosity script failed to load", type, script.src, e);
      postStatus({ type: "preview-error", reason: "script-load" });
    };
    document.body.appendChild(script);
    return () => {
      document.body.removeChild(script);
    };
  }, [type, hasRequest]);

  useEffect(() => {
    if (!scriptLoaded) return;
    if (hasErrors) return;
    // No signed request, no SDK: Learnosity can't initialize an unsigned
    // activity, and trying throws inside the SDK.
    if (!request) return;
    // Skip re-initialization when only the signing envelope changed (host
    // re-signs on focus/reconnect via SWR — see contentKey above). Re-init on
    // the same mounted DOM throws Learnosity's "triggerBufferedEvents" error.
    const key = contentKey(type, request);
    if (initedContentRef.current === key) return;
    const LearnosityApp =
      type === "questions" ? (window as any).LearnosityApp :
      (window as any).LearnosityItems;
    // Defer one frame so React has committed the response spans before
    // Questions API validates the activity JSON against the DOM (error 10001
    // "no matching DOM element" fires otherwise on first load).
    const run = () => {
      if (type === "questions") {
        const qs = request?.questions ?? request?.request?.questions ?? [];
        const missing = qs
          .map((q: { response_id: string }) => q.response_id)
          .filter((rid: string) =>
            !document.querySelector(`.learnosity-response.question-${CSS.escape(rid)}`),
          );
        if (missing.length) {
          requestAnimationFrame(run);
          return;
        }
      }
      // Mark inited only once we actually call init (after the DOM is ready), so
      // a deferred/retried run doesn't get skipped by the guard above.
      initedContentRef.current = key;
      LearnosityApp.init(request, {
        readyListener() {
          // Assessment is interactive. The View's own onload fired long ago;
          // this is the signal a framing host waits for.
          postStatus({ type: "preview-ready" });
        },
        errorListener(err: any) {
          console.error("Learnosity error", type, err);
          postStatus({ type: "preview-error", reason: `learnosity: ${err?.code ?? "error"}` });
        },
      });
    };
    requestAnimationFrame(run);
  }, [scriptLoaded, request, hasErrors, type]);

  if (hasErrors) {
    return renderErrors(errors);
  }
  if ((type === "questions" || type === "items") && !request) {
    if (pending) {
      return <div className="p-4" role="status" aria-busy="true" />;
    }
    return (
      <div role="alert" className="m-4 rounded-md p-3 border text-sm bg-amber-50 border-amber-200 text-amber-900">
        {message || UNSIGNED_MESSAGE}
      </div>
    );
  }
  if (type === "questions") {
    // Questions API renders into .learnosity-response spans keyed by response_id.
    // The Questions SDK returns a flat signed request (questions at the top
    // level); the Items SDK wraps data in {security, request}.
    const questions = request?.questions ?? request?.request?.questions ?? [];
    return (
      <div className="p-4">
        {questions.map((q: { response_id: string }) => (
          <span
            key={q.response_id}
            className={`learnosity-response question-${q.response_id}`}
            data-response-id={q.response_id}
          />
        ))}
      </div>
    );
  }
  if (type === "items") {
    return (
      <div className="p-4">
        <span id="learnosity_assess" className="learnosity-item" data-reference="item-1" />
      </div>
    );
  }
  // No Learnosity type (e.g. a bare `hello` program): show the raw compile data.
  return <pre className="text-xs p-4">{JSON.stringify(state.data, null, 2)}</pre>;
};
