/** @type {import('tailwindcss').Config} */
export default {
  // preflight off: this is a published component — don't inject global CSS resets into
  // consumer apps (or the host page embedding the /form iframe).
  corePlugins: {
    preflight: false,
  },
  // Class-based, not media-based: the deck's theme comes from the program (`theme DARK`) and
  // from the learner's toggle, not from the OS setting of whoever opens the iframe. The Form
  // puts `dark` on its own root, so `dark:` variants are scoped to the deck.
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx,html}", "./embed/**/*.{ts,tsx,html}"],
  theme: {
    extend: {},
  },
  plugins: [],
};
