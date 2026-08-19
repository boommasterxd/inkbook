import eslint from "@eslint/js";
import sonarjs from "eslint-plugin-sonarjs";
import globals from "globals";
import tseslint from "typescript-eslint";

const qualityRules = {
  complexity: ["error", 20],
  "max-depth": ["error", 4],
  "max-lines": [
    "error",
    { max: 500, skipBlankLines: true, skipComments: true },
  ],
  "max-lines-per-function": [
    "error",
    { max: 100, skipBlankLines: true, skipComments: true },
  ],
  "max-params": ["error", 6],
  "sonarjs/cognitive-complexity": ["error", 25],
};
const typescriptFiles = ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"];

export default tseslint.config(
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: typescriptFiles,
  })),
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({
    ...config,
    files: typescriptFiles,
  })),
  sonarjs.configs.recommended,
  {
    files: typescriptFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...qualityRules,
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-empty-function": [
        "error",
        { allow: ["overrideMethods"] },
      ],
      "@typescript-eslint/no-magic-numbers": [
        "error",
        { ignore: [0, 1], ignoreArrayIndexes: true },
      ],
      "@typescript-eslint/no-unnecessary-type-parameters": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs", "eslint.config.mjs"],
    languageOptions: {
      globals: globals.node,
    },
    rules: qualityRules,
  },
  {
    files: ["docs/specification/mockup/**/*.js"],
    languageOptions: {
      globals: globals.browser,
    },
    rules: qualityRules,
  },
);
