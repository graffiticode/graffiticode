// SPDX-License-Identifier: MIT
// Passage / Questions / Answers / Rationale toggle. The compiled item carries BOTH the answerable
// (questions) payload and the answer metadata (correct answers, distractor analysis), plus the
// reading passage, so toggling is local-only — no recompile. "Passage" shows the reading passage in
// its own view; "Questions" shows the items without the passage; "Answers" shows those same items
// as they look once answered — the correct option/sentence/word tinted green with a ✓; "Rationale"
// adds the teacher layer on top: the distractor analysis, answer key, scoring, and warnings.
// Mirrors ThemeToggle's published-component styling constraints (preflight off). (The
// Questions/Rationale mode ids stay `preview`/`review`.)
import { useCallback, useState } from "react";

export type Mode = "preview" | "review" | "passage" | "answers";

const MODES: Mode[] = ["preview", "review", "passage", "answers"];
const STORAGE_KEY = "l0175:form:mode";

// The toggle is a per-reader preference, not item data, so it persists in localStorage and survives
// a page refresh. Every access is guarded: the form is embedded in an iframe, where a third-party
// storage policy can make even reading `window.localStorage` throw.
function readStoredMode(fallback: Mode): Mode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return MODES.includes(stored as Mode) ? (stored as Mode) : fallback;
  } catch {
    return fallback;
  }
}

export function usePersistedMode(fallback: Mode = "preview"): [Mode, (m: Mode) => void] {
  const [mode, setModeState] = useState<Mode>(() => readStoredMode(fallback));
  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    try {
      window.localStorage.setItem(STORAGE_KEY, m);
    } catch {
      // Storage unavailable (private mode, blocked third-party cookies) — keep the in-memory mode.
    }
  }, []);
  return [mode, setMode];
}

export function ModeToggle({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  const opt = (m: Mode, label: string) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      aria-pressed={mode === m}
      className={
        "appearance-none cursor-pointer px-3 py-1 text-xs font-medium rounded-md border transition " +
        (mode === m
          ? "bg-zinc-900 text-white border-zinc-900"
          : "bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-100")
      }
    >
      {label}
    </button>
  );
  return (
    <div className="inline-flex gap-1 self-end">
      {opt("passage", "Passage")}
      {opt("preview", "Questions")}
      {opt("answers", "Answers")}
      {opt("review", "Rationale")}
    </div>
  );
}
