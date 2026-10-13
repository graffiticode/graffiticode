// SPDX-License-Identifier: MIT
// L0013's View: a minimal, read-only harness that fetches the snap task's compiled data and
// renders the Form. Unlike the shared @graffiticode/l0000-view View — which renders blank until
// data is renderable — this keeps the Form mounted throughout, so the Form's "Scraping…" counter
// is visible during the data fetch / render. L0013 output is a static image (non-interactive), so
// there's no recompile-on-edit path. On mount we post `onload` to the host so it reveals the iframe
// (instead of holding its own spinner over us) and our loader owns the wait; we post `data-updated`
// once the snap image is ready.
import { useEffect, useState } from "react";
import type { FormComponent, CompileError } from "@graffiticode/l0000-view";

function apiUrl(): string {
  const host = window.document.location.host;
  return host.indexOf("localhost") === 0 ? "http://localhost:3100" : "https://api.graffiticode.org";
}

export const View = ({ Form }: { Form: FormComponent }) => {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id") ?? undefined;
  const accessToken = params.get("access_token") ?? undefined;
  const origin = params.get("origin") ?? undefined;

  const [data, setData] = useState<any>(undefined);
  const [errors, setErrors] = useState<CompileError[]>([]);

  // Tell the host (the console's iframe viewer) that the form shell has loaded, so it reveals the
  // iframe instead of holding its own spinner over us. The host hides the iframe until it receives
  // either `onload` or `data-updated`; sending `onload` immediately hands the wait to our Form,
  // which shows its "Scraping…" counter until the snap image arrives. No language-specific code is
  // needed on the host — this is the generic "form shell ready" signal.
  useEffect(() => {
    if (origin) window.parent.postMessage({ type: "onload" }, origin);
  }, [origin]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`${apiUrl()}/data?id=${encodeURIComponent(id)}`, {
          headers: { Authorization: accessToken || "" },
        });
        const env = await resp.json();
        if (cancelled) return;
        if (env.status !== "success") {
          setErrors([{ message: env.error?.message || `Failed to load ${id}.` } as CompileError]);
          return;
        }
        // env.data is the compiled snap output { url, item } (or a nested { data, errors }).
        const out =
          env.data && typeof env.data === "object" && Array.isArray(env.data.errors)
            ? { data: env.data.data, errors: env.data.errors as CompileError[] }
            : { data: env.data, errors: [] as CompileError[] };
        setData(out.data);
        setErrors(out.errors);
        if (origin) window.parent.postMessage({ type: "data-updated", data: out.data }, origin);
      } catch (e: any) {
        if (!cancelled) setErrors([{ message: String(e?.message || e) } as CompileError]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, accessToken, origin]);

  // `data` is undefined while loading → the Form renders its "Working…" animation.
  return <Form state={{ data, errors, apply: () => {} }} />;
};
