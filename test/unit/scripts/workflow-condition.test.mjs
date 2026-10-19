import { expect, it } from "vitest";

import { workflowCondition } from "./workflow-condition-fixture.mjs";

it("interprets the policy subset including grouped alternatives and indexed context", () => {
  const context = {
    needs: { select: { outputs: { shared: "true" } } },
    matrix: { suite: "shared" },
    trusted: true,
  };
  expect(
    workflowCondition(
      "trusted == true && (needs.select.outputs[matrix.suite] == 'true' || trusted == false)",
      context,
    ),
  ).toBe(true);
  context.needs.select.outputs.shared = "false";
  expect(workflowCondition("needs.select.outputs[matrix.suite] == 'true'", context)).toBe(false);
});

it.each([
  "process.exit(1)",
  "trusted = false",
  "trusted; true",
  "(() => true)()",
  "false && process.exit(1)",
  "true || process.exit(1)",
  "trusted.constructor == 'x'",
  "trusted['__proto__'] == 'x'",
  "missing == true",
  "trusted === true",
  "trusted + true",
  "trusted == 1",
  "'true'",
  "true && 'truthy'",
  "true &&",
  "",
  "(".repeat(40) + "true" + ")".repeat(40),
  " ".repeat(4097),
])("rejects unsupported or executable condition syntax: %s", (expression) => {
  expect(() => workflowCondition(expression, { trusted: true })).toThrow();
});

it("rejects inherited properties and mismatched comparison types", () => {
  const context = { value: Object.create({ inherited: "allowed" }), flag: true };
  expect(() => workflowCondition("value.inherited == 'allowed'", context)).toThrow();
  expect(() => workflowCondition("flag == 'true'", context)).toThrow();
});
