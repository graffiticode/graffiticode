/** @type {import('tailwindcss').Config} */
export default {
  // preflight off: this is a published component — don't inject global CSS resets into
  // consumer apps (or the host page embedding the /form iframe).
  // L0185 programs carry no theme, so the viewer's OS setting decides.
  darkMode: "media",
  corePlugins: {
    preflight: false,
  },
  content: ["./src/**/*.{ts,tsx,html}", "./embed/**/*.{ts,tsx,html}"],
  theme: {
    extend: {},
  },
  plugins: [],
};
