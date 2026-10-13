// SPDX-License-Identifier: MIT
import React from "react";

function SunIcon(props: React.ComponentPropsWithoutRef<"svg">) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <path d="M12.5 10a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z" />
      <path
        strokeLinecap="round"
        d="M10 5.5v-1M13.182 6.818l.707-.707M14.5 10h1M13.182 13.182l.707.707M10 15.5v-1M6.11 13.889l.708-.707M4.5 10h1M6.11 6.111l.708.707"
      />
    </svg>
  );
}

function MoonIcon(props: React.ComponentPropsWithoutRef<"svg">) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <path d="M15.224 11.724a5.5 5.5 0 0 1-6.949-6.949 5.5 5.5 0 1 0 6.949 6.949Z" />
    </svg>
  );
}

export function ThemeToggle({
  theme,
  setTheme,
}: {
  theme: string | undefined;
  setTheme: (t: string) => void;
}) {
  const otherTheme = theme === "dark" ? "light" : "dark";
  // preflight is off (this is a published component), so the button needs explicit
  // styling: `appearance-none` to drop the browser's default chrome and `self-start` so it
  // does not stretch to full width inside the Form's flex column.
  const base =
    "appearance-none self-center inline-flex items-center justify-center h-8 w-8 p-0 " +
    "rounded-md border cursor-pointer transition";
  const themed =
    theme === "dark"
      ? "bg-zinc-800 border-zinc-700 hover:bg-zinc-700"
      : "bg-white border-zinc-200 hover:bg-zinc-100";
  return (
    <button
      type="button"
      aria-label={`Switch to ${otherTheme} theme`}
      title={`Switch to ${otherTheme} theme`}
      className={`${base} ${themed}`}
      onClick={() => setTheme(otherTheme)}
    >
      {theme === "dark" ? (
        <MoonIcon className="h-5 w-5 stroke-white" />
      ) : (
        <SunIcon className="h-5 w-5 stroke-zinc-900" />
      )}
    </button>
  );
}
