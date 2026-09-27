import obsidian from "eslint-plugin-obsidianmd";
import sonarjs from "eslint-plugin-sonarjs";
import globals from "globals";

const warningRulesAsErrors = Object.fromEntries(
  obsidian.configs.recommended.flatMap((config) =>
    Object.entries(config.rules ?? {})
      .filter(([, value]) => {
        const severity = Array.isArray(value) ? value[0] : value;
        return severity === "warn" || severity === 1;
      })
      .map(([name, value]) => [
        name,
        Array.isArray(value) ? ["error", ...value.slice(1)] : "error",
      ]),
  ),
);

const mobileRuntimePaths = [
  {
    message: "Electron APIs are unavailable on mobile.",
    name: "electron",
  },
  {
    message: "Node.js APIs are unavailable on mobile.",
    name: "fs",
  },
  {
    message: "Node.js APIs are unavailable on mobile.",
    name: "path",
  },
];
const mobileRuntimePatterns = [
  {
    group: ["node:*"],
    message: "Node.js APIs are unavailable in plugin runtime code.",
  },
];
const toolingFiles = [
  ".dependency-cruiser.mjs",
  "eslint.config.mjs",
  "scripts/**/*.mjs",
  "stylelint.config.mjs",
  "test/unit/scripts/**/*.mjs",
  "vitest.config.ts",
];

function restrictImports(paths = [], groups = [], regexes = []) {
  return [
    "error",
    {
      paths: [...mobileRuntimePaths, ...paths],
      patterns: [
        ...mobileRuntimePatterns,
        ...groups.map((group) => ({
          group,
          message: "This import crosses an Inkbook architecture boundary.",
        })),
        ...regexes.map((regex) => ({
          message: "This import crosses an Inkbook architecture boundary.",
          regex,
        })),
      ],
    },
  ];
}

export default [
  {
    ignores: ["coverage/**", "dist/**", "main.js", "node_modules/**"],
  },
  ...obsidian.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,tsx,jsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      sonarjs,
    },
    rules: {
      ...warningRulesAsErrors,
      complexity: ["error", 20],
      "max-depth": ["error", 4],
      "max-lines": ["error", { max: 500 }],
      "max-lines-per-function": ["error", { max: 100, skipBlankLines: false, skipComments: false }],
      "max-params": ["error", 6],
      "sonarjs/cognitive-complexity": ["error", 25],
    },
  },
  {
    files: ["**/*.{ts,mts,cts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/naming-convention": [
        "error",
        {
          format: ["UPPER_CASE"],
          modifiers: ["const", "exported"],
          selector: "variable",
          types: ["array", "boolean", "number", "string"],
        },
        {
          format: ["camelCase", "PascalCase", "UPPER_CASE"],
          leadingUnderscore: "allow",
          selector: "variable",
        },
        {
          format: ["camelCase"],
          leadingUnderscore: "allow",
          selector: "parameter",
        },
        {
          format: ["camelCase", "PascalCase"],
          selector: "function",
        },
        {
          format: ["camelCase"],
          selector: "method",
        },
        {
          custom: { match: false, regex: "^I[A-Z]" },
          format: ["PascalCase"],
          selector: "typeLike",
        },
        {
          format: ["PascalCase", "UPPER_CASE"],
          selector: "enumMember",
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/naming-convention": [
        "error",
        {
          format: ["UPPER_CASE"],
          modifiers: ["const", "exported"],
          selector: "variable",
          types: ["array", "boolean", "number", "string"],
        },
        {
          format: ["camelCase", "UPPER_CASE"],
          leadingUnderscore: "allow",
          selector: "variable",
        },
        {
          format: ["camelCase"],
          leadingUnderscore: "allow",
          selector: "parameter",
        },
        {
          format: ["camelCase"],
          selector: ["function", "method"],
        },
        {
          custom: { match: false, regex: "^I[A-Z]" },
          format: ["PascalCase"],
          selector: "typeLike",
        },
        {
          format: ["PascalCase", "UPPER_CASE"],
          selector: "enumMember",
        },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-exports": ["error", { restrictedNamedExports: ["default"] }],
      "no-restricted-imports": restrictImports(),
      "obsidianmd/prefer-active-doc": "error",
    },
  },
  {
    files: ["src/main.ts", "src/obsidian/plugin-loader.ts"],
    rules: {
      "no-restricted-exports": "off",
    },
  },
  {
    files: ["src/obsidian/embeds/editor-chrome-loader.ts", "src/obsidian/plugin-loader.ts"],
    rules: {
      "no-unsanitized/method": [
        "error",
        {},
        {
          import: {
            escape: { methods: ["sanitizeOwnedModuleUrl"] },
            properties: [0],
          },
        },
      ],
    },
  },
  {
    files: ["src/domain/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictImports(
        [
          { name: "obsidian", message: "Domain code must remain framework-independent." },
          { name: "react", message: "Domain code must remain framework-independent." },
          { name: "react-dom", message: "Domain code must remain framework-independent." },
        ],
        [
          [
            "@codemirror/**",
            "**/editor/**",
            "**/obsidian/**",
            "**/persistence/**",
            "**/rendering/**",
          ],
        ],
      ),
    },
  },
  {
    files: ["src/editor/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictImports(
        [
          { name: "obsidian", message: "Editor orchestration depends only on domain contracts." },
          { name: "react", message: "React belongs to the rendering UI boundary." },
          { name: "react-dom", message: "React belongs to the rendering UI boundary." },
        ],
        [["@codemirror/**", "**/obsidian/**", "**/persistence/**", "**/rendering/**"]],
      ),
    },
  },
  {
    files: ["src/rendering/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictImports(
        [{ name: "obsidian", message: "Host APIs belong to the Obsidian integration boundary." }],
        [["@codemirror/**", "**/obsidian/**", "**/persistence/**"]],
      ),
    },
  },
  {
    files: ["src/rendering/motion/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictImports(
        [
          { name: "obsidian", message: "Motion contracts must remain framework-independent." },
          { name: "react", message: "Motion contracts must remain framework-independent." },
          { name: "react-dom", message: "Motion contracts must remain framework-independent." },
        ],
        [
          [
            "@codemirror/**",
            "react/**",
            "react-dom/**",
            "**/obsidian/**",
            "**/persistence/**",
            "**/rendering/ui/**",
          ],
        ],
        [String.raw`^(?:\.\.?/)+(?:rendering/)?ui(?:/|$)`],
      ),
      "no-restricted-syntax": [
        "error",
        {
          message: "Framework-free motion contracts must not load modules dynamically.",
          selector: "ImportExpression",
        },
      ],
    },
  },
  {
    files: ["src/persistence/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictImports(
        [
          { name: "obsidian", message: "Persistence receives host I/O through narrow ports." },
          { name: "react", message: "Persistence must not depend on UI frameworks." },
          { name: "react-dom", message: "Persistence must not depend on UI frameworks." },
        ],
        [["@codemirror/**", "**/editor/**", "**/obsidian/**", "**/rendering/**"]],
      ),
    },
  },
  {
    files: ["src/rendering/scene/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictImports(
        [
          { name: "obsidian", message: "Host APIs belong to the Obsidian integration boundary." },
          { name: "react", message: "React must not participate in scene rendering." },
          { name: "react-dom", message: "React DOM must not participate in scene rendering." },
        ],
        [
          [
            "@codemirror/**",
            "react/**",
            "react-dom/**",
            "**/obsidian/**",
            "**/persistence/**",
            "**/rendering/ui/**",
          ],
        ],
        [String.raw`^(?:\.\.?/)+(?:rendering/)?ui(?:/|$)`],
      ),
      "no-restricted-syntax": [
        "error",
        {
          message: "The imperative SVG scene must not load modules dynamically.",
          selector: "ImportExpression",
        },
        {
          message: "JSX belongs to React-owned chrome, never to the imperative SVG scene.",
          selector: "JSXElement, JSXFragment",
        },
        {
          message: "React roots, portals, and state APIs must not participate in scene rendering.",
          selector:
            "CallExpression[callee.name=/^(createRoot|hydrateRoot|createPortal|useState|useReducer|useSyncExternalStore)$/], CallExpression[callee.property.name=/^(createRoot|hydrateRoot|createPortal|useState|useReducer|useSyncExternalStore)$/]",
        },
        {
          message: "Scene reconciliation uses retained node references, never selector queries.",
          selector:
            "CallExpression[callee.property.name=/^(querySelector|querySelectorAll|getElementsByClassName|getElementsByTagName)$/]",
        },
        {
          message: "Scene reconciliation must not walk descendant or sibling DOM collections.",
          selector:
            "MemberExpression[property.name=/^(children|childNodes|firstChild|lastChild|firstElementChild|lastElementChild|nextSibling|previousSibling|nextElementSibling|previousElementSibling)$/]",
        },
        {
          message: "Scene reconciliation must not create a DOM tree walker or node iterator.",
          selector:
            "CallExpression[callee.property.name=/^(createTreeWalker|createNodeIterator)$/]",
        },
      ],
    },
  },
  {
    files: ["src/rendering/scene/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          message: "The imperative SVG scene must use TypeScript files, never TSX files.",
          selector: "Program",
        },
      ],
    },
  },
  {
    files: toolingFiles,
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: false,
        project: "./tsconfig.tooling.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "import/no-extraneous-dependencies": "off",
      "obsidianmd/no-nodejs-modules": "off",
    },
  },
  {
    files: ["test/performance/persistence/memory-*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "obsidianmd/no-global-this": "off",
      "obsidianmd/no-nodejs-modules": "off",
    },
  },
  {
    // These Node-only resource contracts count Promise allocations via async_hooks.
    files: [
      "test/performance/editor/selection-hot-paths.test.ts",
      "test/performance/persistence/clipboard.test.ts",
    ],
    rules: {
      "obsidianmd/no-nodejs-modules": "off",
    },
  },
];
