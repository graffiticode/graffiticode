module.exports = {
  env: {
    browser: true,
    es2022: true,
    jest: true,
    node: true,
  },
  extends: 'standard',
  overrides: [
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  plugins: ['import'],
  rules: {
    'quotes': [2, 'double'],
    'semi': [2, 'always'],
    'space-before-function-paren': ['error', {
      'anonymous': 'always',
      'named': 'never',
    }],
    'import/no-unresolved': 0,  // this gives a false positive with 'graphql-request'
    'import/no-commonjs': 2,
    'import/extensions': [2, 'ignorePackages'],
    'no-mixed-operators': 0,
  }
};
