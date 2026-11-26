import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const gate = workflow.split("\n  ci:\n")[1];
const command = gate?.split("        run: |\n")[1];

function runGate(overrides) {
  if (!command) throw new Error("Missing required CI shell gate");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-s"], {
    input: command,
    env: {
      ...process.env,
      SELECT_RESULT: "success",
      QUALITY_RESULT: "success",
      PERFORMANCE_RESULT: "success",
      MODE: "full",
      SHARED: "true",
      CADENCE: "true",
      AUDIT: "success",
      ...overrides,
    },
    timeout: 5_000,
  });
  expect(result.error).toBeUndefined();
  return result.status;
}

it("keeps the required CI gate unconditional and bound to substantive job results", () => {
  expect(gate).toContain("name: CI");
  expect(gate).toContain("if: always()");
  expect(gate).toContain("needs: [select, quality, Performance]");
  expect(workflow).toContain("label: shared");
  expect(workflow).toContain("label: refresh profiles");
});

it.each([
  ["full", "true", "true", "success"],
  ["affected", "true", "false", "success"],
  ["no-impact", "false", "false", "success"],
  ["docs", "false", "false", "skipped"],
])("accepts a validated %s plan", (mode, shared, cadence, audit) => {
  expect(runGate({ MODE: mode, SHARED: shared, CADENCE: cadence, AUDIT: audit })).toBe(0);
});

it.each([
  { SELECT_RESULT: "failure" },
  { QUALITY_RESULT: "cancelled" },
  { PERFORMANCE_RESULT: "skipped" },
  { MODE: "affected", AUDIT: "failure" },
  { MODE: "docs", SHARED: "false", CADENCE: "false" },
  { MODE: "no-impact", SHARED: "false" },
  { MODE: "affected", SHARED: "" },
  { MODE: "unknown" },
])("rejects a failed or inconsistent plan: %j", (overrides) => {
  expect(runGate(overrides)).toBe(1);
});
