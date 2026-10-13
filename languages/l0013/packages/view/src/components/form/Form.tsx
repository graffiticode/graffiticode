// SPDX-License-Identifier: MIT
// L0013's Form: renders the image produced by a `snap` program (the uploaded thumbnail). A single
// status banner shows a "Scraping… Ns" counter across the whole wait (compile in flight + image
// download), then freezes to "Scraped in Ns" with a link to the stored PNG once the image loads.
// Injected into the shared View (from @graffiticode/l0000-view), which supplies `state.data` and
// `state.errors`.
import "../../index.css";
import { useState, useEffect, useRef, type CSSProperties } from "react";
import type { FormProps, CompileError } from "@graffiticode/l0000-view";

// Printer-style crop marks: a short horizontal + vertical tick at each corner, offset just outside
// the image edges, framing the actual (content-aware-cropped) thumbnail. Rendered inside a wrapper
// that's sized to the loaded image, so the ticks hug its real bounds.
function CropMarks() {
  const len = 12; // tick length (px)
  const gap = 4; //  gap between the image edge and the tick (px)
  const th = 1; //   tick thickness (px)
  const tick = (style: CSSProperties, i: number) => (
    <span key={i} className="pointer-events-none absolute bg-zinc-400" style={style} />
  );
  const h = { width: len, height: th }; // horizontal tick
  const v = { width: th, height: len }; // vertical tick
  return (
    <>
      {[
        { top: 0, left: -(gap + len), ...h }, // top-left, along top edge
        { left: 0, top: -(gap + len), ...v }, // top-left, along left edge
        { top: 0, right: -(gap + len), ...h }, // top-right, along top edge
        { right: 0, top: -(gap + len), ...v }, // top-right, along right edge
        { bottom: 0, left: -(gap + len), ...h }, // bottom-left, along bottom edge
        { left: 0, bottom: -(gap + len), ...v }, // bottom-left, along left edge
        { bottom: 0, right: -(gap + len), ...h }, // bottom-right, along bottom edge
        { right: 0, bottom: -(gap + len), ...v }, // bottom-right, along right edge
      ].map(tick)}
    </>
  );
}

type Status = "loading" | "loaded" | "error";

// The status banner. While loading (the server scrapes, then the PNG downloads) it spins and counts
// elapsed seconds; once loaded it reports the total time and links to the stored image.
function StatusBanner({ status, elapsed, url }: { status: Status; elapsed: number; url?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 border-b border-zinc-200 bg-zinc-50 p-4 text-center font-roboto text-base text-zinc-600">
      {status === "loading" && (
        <>
          <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600" />
          Scraping… {elapsed}s
        </>
      )}
      {status === "loaded" && (
        <>
          <span>Scraped in {elapsed}s</span>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 underline hover:text-blue-800"
            >
              View image
            </a>
          )}
        </>
      )}
      {status === "error" && (
        <>
          <span>Couldn’t load image.</span>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 underline hover:text-blue-800"
            >
              Open link
            </a>
          )}
        </>
      )}
    </div>
  );
}

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
  const data: any = state.data;
  const src = typeof data?.url === "string" ? data.url : undefined;

  const [status, setStatus] = useState<Status>("loading");
  const [elapsed, setElapsed] = useState(0);

  // Restart the banner only when one image URL is replaced by a different one (a re-snap). The
  // initial undefined→URL transition must NOT reset — it would discard the scrape time counted so
  // far while the compile was in flight.
  const prevSrc = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (src && prevSrc.current && src !== prevSrc.current) {
      setStatus("loading");
      setElapsed(0);
    }
    prevSrc.current = src;
  }, [src]);

  // Tick the elapsed-seconds counter across the whole wait — compile in flight (no `src` yet) plus
  // the image download — and freeze it once the image has loaded (or errored).
  useEffect(() => {
    if (status !== "loading") return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [status]);

  if (errors.length > 0) {
    return (
      <div className="rounded-md bg-white p-4 font-roboto text-zinc-900">
        {renderErrors(errors)}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md bg-white text-zinc-900">
      <StatusBanner status={status} elapsed={elapsed} url={src} />
      {src && (
        <div className="flex justify-center p-6">
          <div className="relative inline-block">
            <img
              key={src}
              src={src}
              alt={data?.item ? `thumbnail ${data.item}` : "thumbnail"}
              onLoad={() => setStatus("loaded")}
              onError={() => setStatus("error")}
              style={{ display: status === "loaded" ? "block" : "none" }}
            />
            {status === "loaded" && <CropMarks />}
          </div>
        </div>
      )}
    </div>
  );
};
