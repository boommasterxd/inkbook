import { ESLint, Linter } from "eslint";
import { describe, expect, it } from "vitest";

import eslintConfig from "../../../eslint.config.mjs";

const linter = new Linter({ configType: "flat" });
const eslint = new ESLint();

it.each([
  ["src/main.ts", true],
  ["test/fixtures/persistence/isolated-node-process.ts", false],
  ["test/unit/persistence/saving/isolated-node-process.test.ts", false],
])("restricts Node process APIs to the isolated harness in %s", async (filePath, restricted) => {
  const config = await eslint.calculateConfigForFile(filePath);
  const messages = linter.verify(
    'import { spawn } from "node:child_process";\nvoid spawn;\nvoid process.pid;\nvoid Buffer.byteLength("test");',
    {
      files: ["**/*.{ts,mjs}"],
      languageOptions: { globals: config.languageOptions.globals },
      plugins: { obsidianmd: config.plugins.obsidianmd },
      rules: {
        "obsidianmd/no-nodejs-modules": config.rules["obsidianmd/no-nodejs-modules"],
        "no-undef": config.rules["no-undef"],
      },
    },
    { filename: filePath },
  );

  expect(messages.some(({ ruleId }) => ruleId === "obsidianmd/no-nodejs-modules")).toBe(restricted);
  expect(messages.some(({ ruleId }) => ruleId === "no-undef")).toBe(restricted);
});

describe("dependency lint boundaries", () => {
  it("allows the development-only Moment security override", async () => {
    const [result] = await eslint.lintText(
      JSON.stringify({ devDependencies: { moment: "^2.31.0" }, overrides: { moment: "$moment" } }),
      { filePath: "package.json" },
    );

    expect(result.messages).toEqual([]);
  });

  it.each(["dependencies", "optionalDependencies"])("rejects Moment in %s", async (section) => {
    const [result] = await eslint.lintText(JSON.stringify({ [section]: { moment: "^2.31.0" } }), {
      filePath: "package.json",
    });

    expect(result.messages.map(({ ruleId }) => ruleId)).toContain("no-restricted-syntax");
  });

  it("preserves the ban on other replaceable development dependencies", async () => {
    const [result] = await eslint.lintText(
      JSON.stringify({ devDependencies: { "is-number": "7.0.0" } }),
      { filePath: "package.json" },
    );

    expect(result.messages.map(({ ruleId }) => ruleId)).toContain("depend/ban-dependencies");
  });

  it("preserves the ban on direct runtime Moment imports", async () => {
    const config = await eslint.calculateConfigForFile("src/main.ts");
    const ruleId = "@typescript-eslint/no-restricted-imports";
    const messages = linter.verify('import moment from "moment";\nvoid moment;', {
      plugins: { "@typescript-eslint": config.plugins["@typescript-eslint"] },
      rules: { [ruleId]: config.rules[ruleId] },
    });

    expect(messages.map((message) => message.ruleId)).toContain(ruleId);
  });
});

describe("rendering ESLint boundaries", () => {
  it.each(["scene", "motion"])("rejects relative UI imports from %s", (area) => {
    const rule = restrictedImportsRule(area);

    expect(importMessages(rule, "../ui/editor-chrome-types")).toContain("no-restricted-imports");
    expect(importMessages(rule, "../../../rendering/ui/editor-chrome-types")).toContain(
      "no-restricted-imports",
    );
  });

  it.each(["scene", "motion"])("allows framework-free motion imports from %s", (area) => {
    expect(
      lintMessages(area, 'import { value } from "../motion/transitions";\nvoid value;'),
    ).toEqual([]);
  });

  it.each(["scene", "motion"])("rejects dynamic imports from %s", (area) => {
    expect(lintMessages(area, 'void import("../ui/editor-chrome-types");')).toContain(
      "no-restricted-syntax",
    );
  });
});

function restrictedImportsRule(area) {
  const files = `src/rendering/${area}/**/*.{ts,tsx}`;
  const block = eslintConfig.find((entry) => entry.files?.includes(files));
  const rule = block?.rules?.["no-restricted-imports"];
  if (rule === undefined) throw new Error(`Missing no-restricted-imports rule for ${area}.`);
  return rule;
}

function importMessages(rule, source) {
  return verify(`import { value } from "${source}";\nvoid value;`, {
    "no-restricted-imports": rule,
  });
}

function lintMessages(area, code) {
  const files = `src/rendering/${area}/**/*.{ts,tsx}`;
  const block = eslintConfig.find((entry) => entry.files?.includes(files));
  return verify(code, {
    "no-restricted-imports": block?.rules?.["no-restricted-imports"],
    "no-restricted-syntax": block?.rules?.["no-restricted-syntax"],
  });
}

function verify(code, rules) {
  return linter
    .verify(code, {
      languageOptions: { ecmaVersion: "latest", sourceType: "module" },
      rules,
    })
    .map((message) => message.ruleId);
}
