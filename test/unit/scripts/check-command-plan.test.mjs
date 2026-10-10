import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCheckCommandPlan } from "../../../scripts/check-command-plan.mjs";

afterEach(() => vi.unstubAllEnvs());

describe("check command plan", () => {
  it.each([
    ["INKBOOK_PERFORMANCE_SUITE", "shared"],
    ["INKBOOK_PERFORMANCE_SUITE", "cadence"],
    ["INKBOOK_PERFORMANCE_SUITE", "profile"],
  ])("rejects partial local CI through %s=%s", (name, value) => {
    vi.stubEnv(name, value);
    expect(() => createCheckCommandPlan("ci", [], "/npm-cli.js")).toThrow("suite all");
    expect(createCheckCommandPlan("benchmark")).toHaveLength(1);
  });

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
      "audit:braces",
      "audit:dependencies",
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
    expect(plan.find(({ label }) => label === "audit:dependencies").args).toEqual([
      "/npm-cli.js",
      "audit",
      "--audit-level=high",
    ]);
  });

  it("launches the installed architecture CLI", () => {
    const [task] = createCheckCommandPlan("architecture");
    const result = spawnSync(task.command, [task.args[0], "--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
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
