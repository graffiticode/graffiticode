// SPDX-License-Identifier: MIT
// L0176's Form: renders a Learnosity assessment by dynamically loading the
// matching Learnosity browser SDK (questions / author / items) and mounting the
// signed request. Ported from L0158's Form.tsx, adapted to the shared View's
// FormProps contract (state.data / state.errors) — the View (from
// @graffiticode/l0000-view) owns the iframe postMessage/onload protocol, so this
// Form no longer posts to the parent itself.
import "../../index.css";
import { useEffect, useRef, useState } from "react";
import type { FormProps, CompileError } from "@graffiticode/l0000-view";
import { contentKey } from "./contentKey";

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

export const Form = ({ state }: FormProps) => {
  const errors: CompileError[] = state.errors ?? [];
  const hasErrors = errors.length > 0;
  const { type, request } = state.data || {};
  const [scriptLoaded, setScriptLoaded] = useState(false);
  // The content key of the assessment currently mounted into Learnosity. Guards
  // against the host's re-signed-request churn re-initializing the SDK (see
  // contentKey above).
  const initedContentRef = useRef<string | null>(null);

  useEffect(() => {
    if (hasErrors) return;
    if (!type) return;
    // Dynamically load the Learnosity script for this result type. Re-run on
    // type change so preview (questions) and save (items) swap scripts
    // correctly when state.data.type flips post-compile.
    setScriptLoaded(false);
    const script = document.createElement("script");
    script.src =
      type === "questions" ? "https://questions.learnosity.com/?latest-lts" :
      type === "author" ? "https://authorapi.learnosity.com/?latest-lts" :
      "https://items.learnosity.com/?latest-lts";
    script.async = true;
    script.onload = () => setScriptLoaded(true);
    script.onerror = (e) => {
      console.error("Learnosity script failed to load", type, script.src, e);
    };
    document.body.appendChild(script);
    return () => {
      document.body.removeChild(script);
    };
  }, [type]);

  useEffect(() => {
    if (!scriptLoaded) return;
    if (hasErrors) return;
    // Skip re-initialization when only the signing envelope changed (host
    // re-signs on focus/reconnect via SWR — see contentKey above). Re-init on
    // the same mounted DOM throws Learnosity's "triggerBufferedEvents" error.
    const key = contentKey(type, request);
    if (initedContentRef.current === key) return;
    const LearnosityApp =
      type === "questions" ? (window as any).LearnosityApp :
      type === "author" ? (window as any).LearnosityAuthor :
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
          // Assessment is interactive. The shared View posts onload to the
          // parent iframe on data-ready, so nothing to do here.
        },
        errorListener(err: any) {
          console.error("Learnosity error", type, err);
        },
      });
    };
    requestAnimationFrame(run);
  }, [scriptLoaded, request, hasErrors, type]);

  if (hasErrors) {
    return renderErrors(errors);
  }
  if (type === "author") {
    return <div id="learnosity-author" className="p-4" />;
  }
  if (type === "questions") {
    // Questions API renders into .learnosity-response spans keyed by response_id.
    // The Questions SDK returns a flat signed request (questions at the top
    // level); Items/Author SDKs wrap data in {security, request}.
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
