import { expect, it } from "vitest";

import { validateSourceLayout } from "../../../scripts/verify-source-layout.mjs";

it("accepts the supported source, test, and CSS naming contracts", () => {
  const violations = validateSourceLayout([
    { content: "export const value = 1;\n", path: "src/domain/example-file.ts" },
    {
      content: 'import { it } from "vitest";\nit("case", () => {});\n',
      path: "test/unit/example-file.test.ts",
    },
    { content: ".example { color: red; }\n", path: "src/obsidian/styles/example-file.css" },
  ]);

  expect(violations).toEqual([]);
});

it("reports invalid source names, scene TSX, and executable test suffixes", () => {
  const violations = validateSourceLayout([
    { content: "", path: "src/domain/ExampleFile.ts" },
    { content: "", path: "src/rendering/scene/example-view.tsx" },
    {
      content: 'import { it } from "vitest";\nit("case", () => {});\n',
      path: "test/unit/example-file.ts",
    },
  ]);

  expect(violations).toHaveLength(3);
});

it("recognizes direct, namespace, aliased, and global test calls", () => {
  const violations = validateSourceLayout([
    {
      content: 'import * as vitest from "vitest";\nvitest.test("case", () => {});\n',
      path: "test/unit/namespace-test.ts",
    },
    {
      content: 'import { expect } from "vitest";\ntest("case", () => expect(true).toBe(true));\n',
      path: "test/unit/global-test.ts",
    },
    {
      content: 'import { describe } from "vitest";\ndescribe.each([1])("case", () => {});\n',
      path: "test/unit/parameterized-suite.ts",
    },
    {
      content: 'import { test } from "vitest";\ntest.concurrent("case", () => {});\n',
      path: "test/unit/concurrent-test.ts",
    },
    {
      content: 'import { test as scenario } from "vitest";\nscenario("case", () => {});\n',
      path: "test/unit/aliased-test.ts",
    },
    {
      content:
        'import { expect } from "vitest";\nimport { test as laterScenario } from "vitest";\nlaterScenario("case", () => expect(true).toBe(true));\n',
      path: "test/unit/later-aliased-test.ts",
    },
    {
      content:
        'import { expect } from "vitest";\nimport * as laterVitest from "vitest";\nlaterVitest.test("case", () => expect(true).toBe(true));\n',
      path: "test/unit/later-namespace-test.ts",
    },
    {
      content: 'import nodeTest from "node:test";\nnodeTest("case", () => {});\n',
      path: "test/unit/node-default-test.ts",
    },
  ]);

  expect(violations).toEqual([
    "test/unit/namespace-test.ts: executable tests must use the *.test.* suffix.",
    "test/unit/global-test.ts: executable tests must use the *.test.* suffix.",
    "test/unit/parameterized-suite.ts: executable tests must use the *.test.* suffix.",
    "test/unit/concurrent-test.ts: executable tests must use the *.test.* suffix.",
    "test/unit/aliased-test.ts: executable tests must use the *.test.* suffix.",
    "test/unit/later-aliased-test.ts: executable tests must use the *.test.* suffix.",
    "test/unit/later-namespace-test.ts: executable tests must use the *.test.* suffix.",
    "test/unit/node-default-test.ts: executable tests must use the *.test.* suffix.",
  ]);
});

it("resolves local test API shadows within their lexical scopes", () => {
  const violations = validateSourceLayout([
    {
      content: 'import { expect } from "vitest";\nexport const assertValue = expect;\n',
      path: "test/unit/fixture.ts",
    },
    {
      content:
        'import { expect } from "vitest";\nconst test = (actual) => expect(actual).toBe(true);\ntest(true);\n',
      path: "test/unit/local-test-helper.ts",
    },
    {
      content:
        'import { expect } from "vitest";\nimport { test } from "./local-helper";\ntest(expect(true).toBe(true));\n',
      path: "test/unit/later-local-test-helper.ts",
    },
    {
      content:
        'import { expect } from "vitest";\nfunction runHelper(test) { test(); }\ntest("case", () => expect(true).toBe(true));\n',
      path: "test/unit/nested-shadow-test.ts",
    },
    {
      content:
        'import { expect } from "vitest";\n{ const describe = () => {}; describe(); }\ndescribe("case", () => expect(true).toBe(true));\n',
      path: "test/unit/block-shadow-suite.ts",
    },
  ]);

  expect(violations).toEqual([
    "test/unit/nested-shadow-test.ts: executable tests must use the *.test.* suffix.",
    "test/unit/block-shadow-suite.ts: executable tests must use the *.test.* suffix.",
  ]);
});

it("reports CSS files above the hard line limit", () => {
  const violations = validateSourceLayout([
    { content: `${".a {}\n".repeat(500)}.b {}`, path: "src/obsidian/styles/too-large.css" },
  ]);

  expect(violations).toEqual([
    "src/obsidian/styles/too-large.css: CSS files must not exceed 500 lines (found 501).",
  ]);
});
