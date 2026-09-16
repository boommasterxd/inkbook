import { describe, expect, it } from "vitest";

import { createCheckCommandPlan } from "../../../scripts/check-command-plan.mjs";

describe("check command plan", () => {
  it("expands the complete gate once, with performance after quality", () => {
    const plan = createCheckCommandPlan("ci", [], "/npm-cli.js");

    expect(plan.map(({ label }) => label)).toEqual([
      "format:check",
      "lint",
      "lint:styles",
      "lint:layout",
      "architecture",
      "typecheck:runtime",
      "typecheck:test",
      "typecheck:worker",
      "test:coverage",
      "duplication",
      "dead-code",
      "audit",
      "build",
      "package:verify",
      "test:performance",
    ]);
    expect(plan.every(({ command }) => command === process.execPath)).toBe(true);
    expect(plan.find(({ label }) => label === "test:coverage").args.slice(1)).toEqual([
      "run",
      "test/unit",
      "test/integration",
      "--coverage",
    ]);
    expect(plan.find(({ label }) => label === "audit").args).toEqual([
      "/npm-cli.js",
      "audit",
      "--audit-level=high",
    ]);
  });

  it("keeps direct test arguments as literal arguments without a shell", () => {
    const plan = createCheckCommandPlan("test:unit", ["--testNamePattern", "a $(literal) name"]);

    expect(plan[0].args.slice(-2)).toEqual(["--testNamePattern", "a $(literal) name"]);
  });

  it("rejects unknown tasks and ambiguous group arguments before execution", () => {
    expect(() => createCheckCommandPlan("unknown")).toThrow("Unknown check");
    expect(() => createCheckCommandPlan("constructor")).toThrow("Unknown check");
    expect(() => createCheckCommandPlan("ci", ["--coverage"])).toThrow("additional arguments");
    expect(() => createCheckCommandPlan("audit", [], null)).toThrow("through npm run");
  });
});
