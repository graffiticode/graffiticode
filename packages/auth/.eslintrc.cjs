module.exports = {
  env: {
    es2022: true,
    jest: true,
    node: true,
  },
  extends: "standard",
  overrides: [
  ],
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module"
  },
  plugins: ["import"],
  rules: {
    "quotes": [2, "double"],
    "semi": [2, "always"],
    "space-before-function-paren": ["error", {
      "anonymous": "always",
      "named": "never",
    }],
    "import/no-unresolved": 2,
    "import/no-commonjs": 2,
    "import/extensions": [2, "ignorePackages"],
    "no-mixed-operators": 0,
    "camelcase": [2, {
      "allow": ["grant_type", "refresh_token", "access_token"],
    }],
  }
};
