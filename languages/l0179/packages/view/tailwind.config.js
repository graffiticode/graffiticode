/** @type {import('tailwindcss').Config} */
export default {
  // Preflight ON, and this is a change of intent worth stating plainly.
  //
  // It used to be off, for a good reason: this is a published component and global CSS resets
  // leak into whatever embeds it. But that setting never actually took effect — index.css
  // imported @graffiticode/l0166/style.css, which is built with `preflight: true`, so every
  // consumer (the /form embed AND every Learnosity item) has been receiving preflight all along.
  // The renderer's markup is written against those resets.
  //
  // Now that the renderer is ours, leaving it off would silently restyle every existing item.
  // So it stays on and stays visible here. Scoping these resets to the form's own subtree,
  // rather than the document, is the real fix and is its own change.
  corePlugins: {
    preflight: true,
  },
  content: ["./src/**/*.{ts,tsx,html}", "./embed/**/*.{ts,tsx,html}"],
  theme: {
    extend: {},
  },
  plugins: [],
};
