import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const execution = new URL("../../../scripts/check-execution.mjs", import.meta.url).href;
const planning = new URL("../../../scripts/check-command-plan.mjs", import.meta.url).href;
let directory;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "inkbook-validated-tests-"));
  for (const path of ["test/unit", "test/integration"])
    await mkdir(join(directory, path), { recursive: true });
  await symlink(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  await writeFile(
    join(directory, "vitest.config.mjs"),
    'export default { test: { include: ["test/**/*.test.mjs"], maxWorkers: 1, fileParallelism: false, coverage: { include: ["value.js"], reporter: [] } } };',
  );
  await writeFile(join(directory, "value.js"), "export const value = 1;");
  await writeFile(
    join(directory, "test/unit/value.test.mjs"),
    'import { expect, it } from "vitest"; import { value } from "../../value.js"; it("passes", () => expect(value).toBe(1));',
  );
  await writeFile(
    join(directory, "runner.mjs"),
    `import { runExclusiveChecks } from ${JSON.stringify(execution)};
import { createCheckCommandPlan } from ${JSON.stringify(planning)};
const commands = createCheckCommandPlan("ci:quality", [], "/npm-cli.js")
  .filter(({ label }) => label === "test:coverage");
commands.push({ label: "successor", command: process.execPath, args: ["--input-type=module", "-e", 'import { writeFileSync } from "node:fs"; writeFileSync("successor", "ran");'] });
process.exitCode = await runExclusiveChecks(commands, { cwd: process.cwd(), port: 0 });`,
  );
});

afterEach(async () => rm(directory, { recursive: true, force: true }));

function runQualityTestStep() {
  const result = spawnSync(process.execPath, [join(directory, "runner.mjs")], {
    cwd: directory,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, CI: "true" },
  });
  expect(result.error).toBeUndefined();
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

it.each([
  ["passed", 'it("passes", () => expect(true).toBe(true));', 0],
  ["skipped and todo", 'it.skip("skipped", () => {}); it.todo("todo");', 1],
  ["failed", 'it("fails", () => expect(true).toBe(false));', 1],
])(
  "validates real %s Unit/Integration execution before successors",
  async (_, source, status) => {
    await writeFile(
      join(directory, "test/integration/value.test.mjs"),
      `import { expect, it } from "vitest"; ${source}`,
    );
    const result = runQualityTestStep();
    expect(result.status, result.output).toBe(status);
    if (status === 0) expect(await readFile(join(directory, "successor"), "utf8")).toBe("ran");
    else
      await expect(readFile(join(directory, "successor"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    if (source.includes("it.skip")) {
      expect(result.output).toContain("Test status: skipped");
      expect(result.output).toContain("Test status: todo");
    }
  },
  25_000,
);

it.each([
  ["missing report", "", "ENOENT"],
  ["malformed report", "not-json", "JSON"],
  [
    "missing discovered file",
    JSON.stringify({ success: true, testResults: [] }),
    "Missing Vitest results",
  ],
])("rejects zero-exit execution with a %s before successors", async (_, report, message) => {
  await rm(join(directory, "node_modules"));
  await mkdir(join(directory, "node_modules/vitest"), { recursive: true });
  await writeFile(
    join(directory, "node_modules/vitest/vitest.mjs"),
    `import { writeFileSync } from "node:fs";
const report = ${JSON.stringify(report)};
if (report) writeFileSync(process.argv.find((arg) => arg.startsWith("--outputFile=")).slice(13), report);`,
  );
  const result = runQualityTestStep();
  expect(result.status, result.output).toBe(1);
  expect(result.output).toContain(message);
  await expect(readFile(join(directory, "successor"))).rejects.toMatchObject({ code: "ENOENT" });
});
