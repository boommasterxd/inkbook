import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import { createCheckCommandPlan } from "../../../scripts/check-command-plan.mjs";
import { createExecutionSelection, qualityCommands } from "../../../scripts/ci-execution-plan.mjs";
import { cleanupRepositories, commit, createRepository } from "./ci-selection-fixtures.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const npmEntry = "/npm-cli.js";
const testFile = "test/unit/domain/core.test.ts";

afterEach(cleanupRepositories);

it("runs selected tests once with the native runner alongside build and package checks", async () => {
  const plan = { mode: "affected", tests: [testFile] };
  const commands = await qualityCommands(plan, root, npmEntry, true);

  expect(commands.map((command) => command.label)).toEqual(
    createCheckCommandPlan("ci:quality", [], npmEntry)
      .filter((command) => command.label !== "audit")
      .map((command) => (command.label === "test" ? "test (affected)" : command.label)),
  );
  const [affected] = commands.filter((command) => command.label === "test (affected)");
  expect(affected.args.slice(1)).toEqual([testFile, "--", "run", testFile]);
  expect(affected.args[0]).toBe(join(root, "scripts", "run-validated-tests.mjs"));
  expect(commands.map(({ label }) => label)).toEqual(
    expect.arrayContaining(["build", "package:verify"]),
  );
});

it("keeps the unfiltered command for full fallback and skips only tests for proven no impact", async () => {
  const full = await qualityCommands({ mode: "full", tests: [testFile] }, root, npmEntry);
  const noImpact = await qualityCommands({ mode: "no-impact", tests: [] }, root, npmEntry);

  expect(full).toEqual(createCheckCommandPlan("ci:quality", [], npmEntry));
  expect(noImpact).toEqual(full.filter(({ label }) => label !== "test"));
  await expect(qualityCommands({ mode: "full", tests: [] }, root, npmEntry)).rejects.toThrow(
    "Unexpected empty Unit/Integration selection",
  );
});

it("rejects an incomplete, stale, or failed classifier result", async () => {
  const context = await createRepository({ [testFile]: "export const example = 1;" });
  await commit(context.root, { [testFile]: "export const example = 2;" });
  const expected = {
    EXPECTED_MODE: "affected",
    EXPECTED_SHARED: "false",
    EXPECTED_CADENCE: "false",
    EXPECTED_AUDIT: "success",
  };

  expect((await createExecutionSelection(context, expected)).tests).toEqual([testFile]);
  await expect(
    createExecutionSelection(context, { ...expected, EXPECTED_CADENCE: undefined }),
  ).rejects.toThrow("complete expected selection outputs");
  await expect(
    createExecutionSelection(context, { ...expected, EXPECTED_MODE: "no-impact" }),
  ).rejects.toThrow("Selection output mode changed");
  await expect(
    createExecutionSelection(context, { ...expected, EXPECTED_AUDIT: "failure" }),
  ).rejects.toThrow("audit did not complete");
});
