// Flat ESLint config shared across all workspaces.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-embed/**",
      "**/static/**",
      "**/node_modules/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // The ported compiler is dynamic by nature (AST node dispatch, CPS).
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // The compiler core uses index-signature dispatch and `this[tag]` lookups.
    files: ["packages/core/src/compiler.ts", "packages/core/src/visitor.ts"],
    rules: {
      "@typescript-eslint/no-this-alias": "off",
      "no-prototype-builtins": "off",
    },
  },
  {
    // The spreadsheet renderer, adopted from L0166 (see components/form/TableEditor.tsx).
    // It is a transcription, so it is not reformatted to this repo's taste — the same rule that
    // governs core's validation.ts and params.ts. What is turned off here, and why:
    //
    //   no-self-assign          `editorView = editorView` inside ProseMirror plugin callbacks,
    //                           a no-op the original uses to mark a parameter as read.
    //   no-unused-expressions   `import React from "react"; React;`, the in-scope-for-JSX idiom.
    //   prefer-spread           `.apply()` calls in the table-building path.
    //
    // no-unsafe-optional-chaining is NOT disabled and is left failing deliberately if it ever
    // reappears: `[...cell?.deps]` throws when `deps` is undefined rather than short-circuiting,
    // which is a latent crash inherited from L0166. It is suppressed inline at each site with a
    // note, so fixing it is a deliberate behaviour change rather than a lint cleanup.
    files: ["packages/view/src/components/form/*.tsx"],
    rules: {
      "no-self-assign": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "prefer-spread": "off",
    },
  },
);
