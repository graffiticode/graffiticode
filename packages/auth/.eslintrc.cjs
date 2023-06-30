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
    "camelcase": [2, {
      "allow": ["grant_type", "refresh_token", "access_token"],
    }],
    "comma-dangle": ["error", "only-multiline"],
    "import/extensions": [2, "ignorePackages"],
    "import/no-commonjs": 2,
    "no-mixed-operators": 0,
    "quotes": [2, "double"],
    "semi": [2, "always"],
    "space-before-function-paren": ["error", {
      "anonymous": "always",
      "named": "never",
    }],
  }
};
