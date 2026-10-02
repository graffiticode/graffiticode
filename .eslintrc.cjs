module.exports = {
  env: {
    es2022: true,
    jest: true,
    node: true,
  },
  extends: 'standard',
  overrides: [
    // TypeScript sources (TS migration phase 3). Inert until the first .ts
    // file: everything below applies only to *.ts.
    {
      files: ["*.ts"],
      parser: "@typescript-eslint/parser",
      plugins: ["@typescript-eslint"],
      rules: {
        // TypeScript checks these itself; the core rules misreport TS syntax.
        "no-undef": "off",
        "no-unused-vars": "off",
        "@typescript-eslint/no-unused-vars": ["error", { args: "none", ignoreRestSiblings: true }],
        "no-redeclare": "off",
        "@typescript-eslint/no-redeclare": "error",
        "no-use-before-define": "off",
        "@typescript-eslint/no-use-before-define": ["error", { functions: false, classes: false, variables: false, typedefs: false }],
        "no-useless-constructor": "off",
        // Mechanical conversion: no syntax that emits runtime code.
        "@typescript-eslint/parameter-properties": "error",
        "no-restricted-syntax": ["error",
          { selector: "Decorator", message: "Decorators emit runtime code; not allowed in the migration." },
          { selector: "TSEnumDeclaration", message: "Enums emit runtime code; use a union or a frozen object." },
          { selector: "TSModuleDeclaration[declare!=true]", message: "Namespaces emit runtime code." },
        ],
      },
    },
  ],
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module"
  },
  plugins: ["import"],
  settings: {
    // Resolve the .js specifiers NodeNext requires ("./app.js") to app.ts
    // once a file is converted; plain .js files resolve exactly as before.
    "import/resolver": { typescript: { alwaysTryTypes: true }, node: true },
  },
  rules: {
    "camelcase": [2, {
      "allow": ["grant_type", "refresh_token", "access_token"],
    }],
    "comma-dangle": ["error", "only-multiline"],
    // NodeNext needs the emitted file's name in a specifier: "./app.js" for
    // app.ts. Require .js, in JS and TS files alike; never allow .ts.
    "import/extensions": [2, "ignorePackages", { js: "always", ts: "never" }],
    "import/no-commonjs": 2,
    "no-mixed-operators": 0,
    "quotes": [2, "double"],
    "semi": [2, "always"],
    "space-before-function-paren": ["error", {
      "anonymous": "always",
      "named": "never",
    }],
  }
}
