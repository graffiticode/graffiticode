// SPDX-License-Identifier: MIT
// /form?source=parent: render an item the embedding page hands in, instead of
// fetching it.
//
// The MCP widget frames this page to show L0176 items inline (Learnosity can't
// run in the widget's own sandbox). Fetching by task id only works for a public
// task; a signed-in user's task is private, and their token must not travel to
// the frame. But the widget already holds the compiled item, signed for this
// page's domain, so it posts it here:
//
//   frame  ── { type: "preview-awaiting-data" } ──▶ parent   (to the origin param only)
//   parent ── { type: "preview-data", data }    ──▶ frame
//
// Only the first `preview-data` counts, and only from window.parent at exactly
// the `origin` this page was given. Nothing is fetched, read by id or stored.
// The Form then signs again only what it always would (an unsigned or
// substituted questions activity, or a stale one; Form.tsx), and reports
// preview-ready / preview-error as usual (preview-status.ts).
import { useEffect, useReducer, useState } from "react";
import type { ReactElement } from "react";
import type { CompileError, FormProps } from "@graffiticode/l0000-view";
import { previewTargetOrigin } from "./preview-status";

type FormComponent = (props: FormProps) => ReactElement | null;

/**
 * The compile envelope `{ data, errors }` → its parts; anything else is a bare value.
 *
 * The shared View's own rule (l0000-view `asEnvelope`, not exported): a payload is an
 * envelope iff it is an object whose `errors` is an array. Merely having a `data`
 * property is not the test: an activity `{ type, data }` has one too.
 */
export function asEnvelope(payload: any): { data: any; errors: CompileError[] } {
  if (payload && typeof payload === "object" && Array.isArray(payload.errors)) {
    return { data: payload.data ?? null, errors: payload.errors };
  }
  return { data: payload, errors: [] };
}

// L0176's Form is display-only (Learnosity owns the responses), but it is given
// a working `apply`, as every host gives its Form.
const reduce = (data: any, action: { type: string; args?: any }) => {
  switch (action?.type) {
    case "init":
      return action.args;
    default:
      return data && typeof data === "object" && action?.args && typeof action.args === "object"
        ? { ...data, ...action.args }
        : data;
  }
};

export const ParentFed = ({ Form }: { Form: FormComponent }) => {
  const [origin] = useState(() => previewTargetOrigin());
  const [errors, setErrors] = useState<CompileError[] | null>(null);
  const [data, apply] = useReducer(reduce, undefined);

  useEffect(() => {
    if (!origin || window.parent === window) return;
    let received = false;
    const onMessage = (event: MessageEvent) => {
      if (received || event.source !== window.parent || event.origin !== origin) return;
      const msg = event.data;
      if (!msg || typeof msg !== "object" || msg.type !== "preview-data") return;
      received = true;
      window.removeEventListener("message", onMessage);
      const env = asEnvelope(msg.data);
      apply({ type: "init", args: env.data });
      setErrors(env.errors);
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "preview-awaiting-data" }, origin);
    return () => window.removeEventListener("message", onMessage);
  }, [origin]);

  if (!origin) {
    return (
      <div role="alert" className="m-4 rounded-md p-3 border text-sm bg-amber-50 border-amber-200 text-amber-900">
        This page shows an item handed to it by the page that embeds it, and needs an origin to receive it.
      </div>
    );
  }
  if (errors === null) return <div className="p-4" role="status" aria-busy="true" />;
  return <Form state={{ data, errors, apply }} />;
};
