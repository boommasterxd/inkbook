import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const runProcess = promisify(execFile);
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 12 * 60 * 1000;
const REFRESH_RATES = [60, 90, 120, 144, 240];

export function normalizeKernelFiles(root, testFiles) {
  if (!Array.isArray(testFiles) || testFiles.length === 0)
    throw new Error("Empty comparison file selection.");
  const files = testFiles.map((file) => {
    if (typeof file !== "string" || !file) throw new Error("Invalid comparison file.");
    const normalized = relative(resolve(root), resolve(root, file)).replaceAll("\\", "/");
    if (
      isAbsolute(normalized) ||
      !/^test\/performance\/.+\.test\.ts$/.test(normalized) ||
      normalized.split("/").includes("..")
    ) {
      throw new Error(`Unsafe comparison file: ${file}.`);
    }
    return normalized;
  });
  if (new Set(files).size !== files.length) throw new Error("Duplicate comparison file selection.");
  return files;
}

export function createKernelDriver({
  root,
  referenceRoot,
  candidateRoot,
  files,
  refreshRate,
  temporary,
  resultPath,
  validationOnly = false,
  contractMeasurements,
  forceComparison = false,
  coverageOnly = false,
  roundIndex = 0,
}) {
  validateRoundIndex(roundIndex);
  const from = (path) => JSON.stringify(join(root, path));
  const data = JSON.stringify({
    referenceRoot,
    candidateRoot,
    files,
    refreshRate,
    temporary,
    resultPath,
    root,
    validationOnly,
    contractMeasurements,
    forceComparison,
    coverageOnly,
    roundIndex,
  });
  return `import { test } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bundleComparisonVariant, createComparisonImplementation, planKernelComparisons, validateKernelAccounting } from ${from("scripts/performance-kernel-bundle.mjs")};
import { createKernelInputGraph } from ${from("scripts/performance-kernel-inputs.mjs")};
import { validateKernelScenarios, createKernelProgressReporter } from ${from("scripts/performance-kernel-batch.mjs")};
import { COMPARISON_SCENARIOS, selectComparisonScenarios } from ${from("test/performance/comparison/scenarios.ts")};
import { runPairedScenarios } from ${from("test/performance/comparison/paired-runner.ts")};
import { groupComparisonScenarios } from ${from("test/performance/comparison/paired-groups.ts")};
const options = ${data};
test("complete paired comparison batch", async () => {
  const onProgress = createKernelProgressReporter();
  onProgress({ phase: "driver-start", ids: [] });
  const selectedFiles = new Set(options.files);
  if (options.contractMeasurements?.some((record) => !selectedFiles.has(record.file) || (!options.coverageOnly && record.refreshRate !== options.refreshRate))) throw new Error("Contract measurements differ from the selected file/profile population.");
  const scenarios = options.contractMeasurements === undefined
    ? COMPARISON_SCENARIOS.filter((scenario) => scenario.covers.some(({ file }) => selectedFiles.has(file)))
    : selectComparisonScenarios(options.contractMeasurements);
  if (scenarios.length === 0) throw new Error("No comparison scenarios selected.");
  groupComparisonScenarios(scenarios);
  const covered = new Set(scenarios.flatMap((scenario) => scenario.covers.map(({ file }) => file)));
  for (const file of selectedFiles) if (!covered.has(file)) throw new Error("Missing comparison coverage: " + file);
  if (options.coverageOnly) {
    if (options.contractMeasurements === undefined) throw new Error("Coverage-only checks require original contract measurements.");
    await writeFile(options.resultPath, JSON.stringify({ kind: "kernel-coverage", ids: scenarios.map(({ id }) => id) }, null, 2) + "\\n");
    return;
  }
  const modules = [...new Set(scenarios.flatMap((scenario) => scenario.modules))];
  const referencePath = join(options.temporary, "reference.mjs");
  const candidatePath = join(options.temporary, "candidate.mjs");
  onProgress({ phase: "bundle-reference", ids: [] });
  const referenceBundle = await bundleComparisonVariant({ sourceRoot: options.referenceRoot, harnessRoot: options.root, modules, outputPath: referencePath });
  onProgress({ phase: "bundle-candidate", ids: [] });
  const candidateBundle = await bundleComparisonVariant({ sourceRoot: options.candidateRoot, harnessRoot: options.root, modules, outputPath: candidatePath });
  onProgress({ phase: "import-variants", ids: [] });
  const reference = createComparisonImplementation((await import(/* @vite-ignore */ referencePath)).modules);
  const candidate = createComparisonImplementation((await import(/* @vite-ignore */ candidatePath)).modules);
  if (options.validationOnly) await validateKernelScenarios({ scenarios, reference, candidate, refreshRate: options.refreshRate, roundIndex: options.roundIndex, runPairedScenarios, onProgress });
  let report;
  if (options.validationOnly) {
    report = { kind: "kernel-validation", success: true, refreshRate: options.refreshRate, scenarios: scenarios.map(({ id }) => id) };
  } else {
    onProgress({ phase: "input-graphs", ids: [] });
    const referenceGraph = await createKernelInputGraph({ sourceRoot: options.referenceRoot, metafile: referenceBundle.metafile });
    const candidateGraph = await createKernelInputGraph({ sourceRoot: options.candidateRoot, metafile: candidateBundle.metafile });
    const plan = planKernelComparisons({ scenarios, referenceGraph, candidateGraph, refreshRate: options.refreshRate, forceComparison: options.forceComparison });
    const measurements = plan.pending.length === 0 ? [] : await runPairedScenarios({ scenarios: plan.pending, reference, candidate, refreshRate: options.refreshRate, roundIndex: options.roundIndex, onProgress });
    validateKernelAccounting({ scenarios, measurements, identicalInputs: plan.identicalInputs, refreshRate: options.refreshRate });
    report = { measurements, identicalInputs: plan.identicalInputs, scenarioInputs: plan.scenarioInputs,
      bundles: { reference: referenceBundle.bundleSha256, candidate: candidateBundle.bundleSha256 } };
  }
  onProgress({ phase: "write-result", ids: [] });
  await writeFile(options.resultPath, JSON.stringify(report) + "\\n");
});
`;
}

export function createKernelProgressReporter({
  write = (line) => process.stderr.write(line),
  memoryUsage = () => process.memoryUsage(),
} = {}) {
  let count = 0;
  return ({ phase, ids }) => {
    if (
      ++count > 2048 ||
      typeof phase !== "string" ||
      phase.length > 64 ||
      !Array.isArray(ids) ||
      ids.length > 500 ||
      ids.some((id) => typeof id !== "string" || id.length > 256)
    ) {
      throw new Error("Kernel progress diagnostics exceeded their bounded contract.");
    }
    const { heapUsed, heapTotal, rss, external, arrayBuffers } = memoryUsage();
    write(
      `INKBOOK_KERNEL_PROGRESS ${JSON.stringify({ phase, ids, heapUsed, heapTotal, rss, external, arrayBuffers })}\n`,
    );
  };
}

function validateRoundIndex(roundIndex) {
  if (!Number.isInteger(roundIndex) || roundIndex < 0 || roundIndex > 2) {
    throw new Error("Comparison round index must be 0, 1, or 2.");
  }
}

export async function validateKernelScenarios({
  scenarios,
  reference,
  candidate,
  refreshRate,
  runPairedScenarios,
  roundIndex = 0,
  onProgress,
}) {
  validateRoundIndex(roundIndex);
  const sequences = scenarios.filter((scenario) =>
    ["sequence", "async-sequence"].includes(scenario.execution),
  );
  if (sequences.length > 0) {
    await runPairedScenarios({
      scenarios: sequences,
      reference,
      candidate,
      refreshRate,
      roundIndex,
      onProgress,
    });
  }
  for (const scenario of scenarios.filter((value) => !sequences.includes(value))) {
    for (const implementation of [reference, candidate]) {
      const kernel = await scenario.create(implementation, refreshRate);
      try {
        await kernel.reset?.();
        const result = await kernel.run();
        await kernel.verify(result);
      } finally {
        await kernel.dispose();
      }
    }
  }
}

export function configureKernelVitest(base, { driverPath, temporary }) {
  return {
    ...base,
    cacheDir: join(temporary, "cache"),
    test: {
      ...base.test,
      environment: "happy-dom",
      setupFiles: [],
      include: [driverPath],
      reporters: [["json", { stdout: true }]],
      execArgv: [
        ...(base.test.execArgv ?? []).filter((arg) => !arg.startsWith("--max-old-space-size=")),
        "--max-old-space-size=768",
      ],
      testTimeout: TIMEOUT_MS,
      hookTimeout: TIMEOUT_MS,
      fileParallelism: false,
      maxWorkers: 1,
      isolate: true,
    },
  };
}

function createDriverConfig(root, driverPath, temporary) {
  return `import base from ${JSON.stringify(join(root, "vitest.config.ts"))};
import { configureKernelVitest } from ${JSON.stringify(join(root, "scripts/performance-kernel-batch.mjs"))};
export default configureKernelVitest(base, ${JSON.stringify({ driverPath, temporary })});
`;
}

export function validateKernelProcessReport(stdout) {
  const report = JSON.parse(stdout);
  if (
    report.success !== true ||
    !Array.isArray(report.testResults) ||
    report.testResults.length !== 1
  ) {
    throw new Error("Comparison Vitest batch did not complete successfully.");
  }
  const result = report.testResults[0];
  if (
    result.status !== "passed" ||
    !Array.isArray(result.assertionResults) ||
    result.assertionResults.length !== 1 ||
    result.assertionResults[0].status !== "passed"
  ) {
    throw new Error("Comparison test did not pass exactly once.");
  }
}

async function executeDriver(root, configPath, reportDirectory, refreshRate) {
  const env = { ...process.env, INKBOOK_PERFORMANCE_REFRESH_RATE: String(refreshRate) };
  delete env.INKBOOK_PERFORMANCE_PROFILE;
  delete env.INKBOOK_PERFORMANCE_REPORT;
  env.INKBOOK_PERFORMANCE_MODE = "contracts";
  let output;
  try {
    output = await runProcess(
      process.execPath,
      [
        "--expose-gc",
        join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        configPath,
        "--fileParallelism=false",
        "--maxWorkers=1",
        "--isolate",
      ],
      {
        cwd: root,
        env,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
    );
  } catch (error) {
    await writeFile(join(reportDirectory, "kernel-stdout.log"), error.stdout ?? "");
    await writeFile(join(reportDirectory, "kernel-stderr.log"), error.stderr ?? error.message);
    throw new Error(`Comparison process failed: ${error.message}`, { cause: error });
  }
  await writeFile(join(reportDirectory, "kernel-stdout.log"), output.stdout);
  await writeFile(join(reportDirectory, "kernel-stderr.log"), output.stderr);
  validateKernelProcessReport(output.stdout);
}

export async function runKernelBatch({
  root,
  referenceRoot,
  candidateRoot,
  testFiles,
  refreshRate,
  reportDirectory,
  validationOnly = false,
  contractMeasurements,
  forceComparison = false,
  coverageOnly = false,
  roundIndex = 0,
}) {
  validateRoundIndex(roundIndex);
  if (forceComparison && process.env.CI === "true")
    throw new Error("Forced comparisons are a local diagnostic only.");
  root = resolve(root);
  reportDirectory = resolve(reportDirectory);
  if (!REFRESH_RATES.includes(refreshRate)) throw new Error("Unsupported comparison refresh rate.");
  const files = normalizeKernelFiles(root, testFiles);
  await mkdir(reportDirectory, { recursive: true });
  const resultPath = join(reportDirectory, "kernel.json");
  await rm(resultPath, { force: true });
  const temporary = await mkdtemp(join(root, ".inkbook-kernel-"));
  try {
    const driverPath = join(temporary, "driver.test.ts");
    const configPath = join(temporary, "vitest.config.mjs");
    await writeFile(
      driverPath,
      createKernelDriver({
        root,
        referenceRoot: resolve(referenceRoot),
        candidateRoot: resolve(candidateRoot),
        files,
        refreshRate,
        temporary,
        resultPath,
        validationOnly,
        contractMeasurements,
        forceComparison,
        coverageOnly,
        roundIndex,
      }),
    );
    await writeFile(configPath, createDriverConfig(root, driverPath, temporary));
    await executeDriver(root, configPath, reportDirectory, refreshRate);
    return JSON.parse(await readFile(resultPath, "utf8"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
