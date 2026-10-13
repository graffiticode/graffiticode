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
);
