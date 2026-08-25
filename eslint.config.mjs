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
const defaultProjectFiles = [
  "eslint.config.mjs",
  "scripts/*.mjs",
  "test/unit/scripts/*.test.mjs",
  "vitest.config.ts",
];

function restrictImports(paths = [], groups = []) {
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
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictImports(),
      "obsidianmd/prefer-active-doc": "error",
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
      "no-restricted-syntax": [
        "error",
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
    files: ["scripts/**/*.mjs", "test/unit/scripts/**/*.mjs", "eslint.config.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: defaultProjectFiles,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "import/no-extraneous-dependencies": "off",
      "obsidianmd/no-nodejs-modules": "off",
    },
  },
  {
    files: ["vitest.config.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: defaultProjectFiles,
        },
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
];
