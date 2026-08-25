import { Linter } from "eslint";
import { describe, expect, it } from "vitest";

import eslintConfig from "../../../eslint.config.mjs";

const linter = new Linter({ configType: "flat" });

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
