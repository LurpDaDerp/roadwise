module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "script",
  },
  extends: [
    "eslint:recommended",
    "google",
  ],
  rules: {
    "no-restricted-globals": ["error", "name", "length"],
    "prefer-arrow-callback": "error",
    "quotes": ["error", "double", {"allowTemplateLiterals": true}],
    // The repo is checked out with core.autocrlf=true on Windows, so the working copy
    // legitimately has CRLF endings. Enforcing LF here only produces noise.
    "linebreak-style": "off",
    // JSDoc on every function is not this codebase's convention.
    "require-jsdoc": "off",
    "valid-jsdoc": "off",
    "max-len": ["error", {"code": 100, "ignoreUrls": true, "ignoreTemplateLiterals": true}],
    "object-curly-spacing": "off",
    "indent": ["error", 2, {"SwitchCase": 1}],
  },
  overrides: [
    {
      files: ["test/**/*.js"],
      env: {
        jest: true,
        mocha: true,
      },
      rules: {},
    },
  ],
  globals: {},
};
