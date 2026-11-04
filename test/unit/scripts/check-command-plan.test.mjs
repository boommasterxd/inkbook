import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCheckCommandPlan } from "../../../scripts/check-command-plan.mjs";

afterEach(() => vi.unstubAllEnvs());

describe("check command plan", () => {
  it.each([
    ["INKBOOK_PERFORMANCE_SUITE", "shared"],
    ["INKBOOK_PERFORMANCE_SUITE", "cadence"],
    ["INKBOOK_PERFORMANCE_SUITE", "profile"],
    ["INKBOOK_PERFORMANCE_REFRESH_RATE", "60"],
  ])("rejects partial full commands through %s=%s", (name, value) => {
    vi.stubEnv(name, value);
    for (const command of ["ci", "benchmark", "test:performance"]) {
      expect(() => createCheckCommandPlan(command, [], "/npm-cli.js")).toThrow("suite all");
    }
  });

  it("expands the complete gate once, with performance after quality", () => {
    const plan = createCheckCommandPlan("ci", [], "/npm-cli.js");

    expect(plan.map(({ label }) => label)).toEqual([
      "docs:check",
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
    expect(plan.find(({ label }) => label === "test:coverage").args[0]).toMatch(
      /scripts\/run-validated-tests\.mjs$/,
    );
    expect(plan.find(({ label }) => label === "test:coverage").args.slice(1)).toEqual([
      "test/unit",
      "test/integration",
      "--",
      "run",
      "test/unit",
      "test/integration",
      "--coverage",
    ]);
    expect(plan.find(({ label }) => label === "audit").args).toEqual([
      "/npm-cli.js",
      "audit",
      "--omit=dev",
      "--audit-level=high",
    ]);
  });

  it("also rejects shard overrides at the direct full-performance entrypoint", () => {
    const [task] = createCheckCommandPlan("benchmark");
    const result = spawnSync(task.command, task.args, {
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, INKBOOK_PERFORMANCE_SUITE: "shared" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unset shard overrides");
    expect(result.stdout).not.toContain("Deterministic contracts:");
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

it("accepts unique TSX and rejects duplicated TSX through the installed duplication gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inkbook-tsx-duplication-"));
  try {
    await copyFile(
      new URL("../../../.jscpd.json", import.meta.url),
      join(directory, ".jscpd.json"),
    );
    for (const name of ["src", "test", "scripts"]) await mkdir(join(directory, name));
    const source = `export function ToolbarFixture({ label, disabled }: { label: string; disabled: boolean }) {
  return (
    <section aria-label="Fixture toolbar">
      <button type="button" disabled={disabled} aria-label={label}>
        <span>{label}</span>
        <span aria-hidden="true">Inkbook</span>
      </button>
    </section>
  );
}
`;
    await writeFile(join(directory, "src/first.tsx"), source);
    const [task] = createCheckCommandPlan("duplication", ["--workers", "1"]);
    const scan = () =>
      spawnSync(task.command, task.args, {
        cwd: directory,
        encoding: "utf8",
        timeout: 10_000,
      });
    const unique = scan();
    expect(unique.error).toBeUndefined();
    expect(unique.status, `${unique.stdout}${unique.stderr}`).toBe(0);
    expect(unique.stdout).toContain("tsx");

    await writeFile(join(directory, "src/second.tsx"), source);
    const duplicate = scan();
    expect(duplicate.error).toBeUndefined();
    expect(duplicate.status, `${duplicate.stdout}${duplicate.stderr}`).toBe(1);
    expect(duplicate.stdout).toContain("Clone found (tsx)");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 25_000);
