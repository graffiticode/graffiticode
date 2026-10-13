// Inherits the repo's root .eslintrc.cjs (including its TypeScript override)
// and adds only what common enforces beyond it.
module.exports = {
  rules: {
    "import/no-unresolved": 2,
  },
};
