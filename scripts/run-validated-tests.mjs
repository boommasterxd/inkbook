import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseBatchReport } from "./performance-batch.mjs";
import { collectTestFiles } from "./performance-test-runner.mjs";
import { executeCommands } from "./check-execution.mjs";

async function runTests() {
  const args = process.argv.slice(2);
  const separator = args.indexOf("--");
  if (separator < 1) throw new Error("Expected test paths followed by -- and Vitest arguments.");
  const root = process.cwd();
  const testFiles = [];
  for (const path of args.slice(0, separator)) {
    const absolute = resolve(root, path);
    testFiles.push(
      ...((await stat(absolute)).isDirectory() ? await collectTestFiles(absolute) : [absolute]),
    );
  }
  if (!testFiles.length) throw new Error("Unexpected empty Unit/Integration discovery.");
  const directory = await mkdtemp(join(tmpdir(), "inkbook-test-results-"));
  try {
    const report = join(directory, "tests.json");
    const status = await executeCommands(
      [
        {
          label: "Unit/Integration tests",
          command: process.execPath,
          args: [
            resolve(root, "node_modules/vitest/vitest.mjs"),
            ...args.slice(separator + 1),
            "--reporter=default",
            "--reporter=json",
            `--outputFile=${report}`,
          ],
        },
      ],
      root,
      // Finish child-group cleanup before the outer check guard escalates after five seconds.
      { timeoutMs: 20 * 60 * 1000, shutdownGraceMs: 2_000 },
    );
    if (status !== 0) return status;
    const parsed = parseBatchReport({
      root,
      testFiles,
      refreshRate: 120,
      stdout: await readFile(report, "utf8"),
    });
    for (const violation of parsed.violations)
      process.stderr.write(`${violation.file}: ${violation.message}\n`);
    return parsed.violations.length ? 1 : 0;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await runTests();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
