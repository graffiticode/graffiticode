/** @type {import('tailwindcss').Config} */
export default {
  // preflight off: this is a published component — don't inject global CSS resets into
  // consumer apps (or the host page embedding the /form iframe).
  // Class-based: the theme comes from the program and the learner's toggle, not from the OS
  // setting of whoever opens the iframe. The Form puts `dark` on `.l0184-charts`.
  darkMode: "class",
  corePlugins: {
    preflight: false,
  },
  content: ["./src/**/*.{ts,tsx,html}", "./embed/**/*.{ts,tsx,html}"],
  theme: {
    extend: {},
  },
  plugins: [],
};
