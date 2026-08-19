import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import path from "node:path";

import { runAsCli } from "./cli.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const PACKAGE_FILES = ["main.js", "manifest.json", "styles.css"];
const OPTIONAL_RELEASE_FILES = ["SHA256SUMS"];

export class ArtifactBudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArtifactBudgetError";
  }
}

function assertPositiveNumber(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ArtifactBudgetError(`${label} must be a positive number`);
  }
}

function assertBudgetShape(budget) {
  if (budget?.schema !== "ARTIFACT_BUDGET_V1" || budget.version !== 1) {
    throw new ArtifactBudgetError("Unsupported artifact budget schema");
  }

  const limitKeys = [
    "mainRawBytes",
    "mainGzipBytes",
    "embeddedWorkerRawBytes",
    "stylesRawBytes",
    "stylesGzipBytes",
  ];
  for (const key of limitKeys) {
    assertPositiveNumber(budget.limits?.[key], `limits.${key}`);
  }

  const runtimeKeys = [
    "moduleCssTopLevelEvaluationP95Ms",
    "preOnloadSettledP95Ms",
    "peakAdditionalHeapMiB",
  ];
  for (const key of runtimeKeys) {
    assertPositiveNumber(
      budget.runtime?.[key]?.desktopTablet,
      `runtime.${key}.desktopTablet`,
    );
    assertPositiveNumber(
      budget.runtime?.[key]?.androidPhone,
      `runtime.${key}.androidPhone`,
    );
  }
}

export async function loadArtifactBudget(
  configPath = path.join(REPOSITORY_ROOT, "config/artifact-budget.v1.json"),
) {
  let budget;
  try {
    budget = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new ArtifactBudgetError(
      `Cannot read artifact budget: ${error.message}`,
    );
  }
  assertBudgetShape(budget);
  return budget;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function deterministicGzip(value) {
  return gzipSync(value, { level: 9, mtime: 0 });
}

export function extractEmbeddedWorker(mainSource) {
  const candidates = mainSource.matchAll(/String\.raw`([\s\S]*?)`/g);
  for (const candidate of candidates) {
    const workerSource = candidate[1];
    if (
      workerSource.includes("self.addEventListener") &&
      workerSource.includes("PROTOCOL_VERSION")
    ) {
      return workerSource;
    }
  }
  throw new ArtifactBudgetError(
    "Embedded phase-zero worker payload was not found in main.js",
  );
}

async function readPackageFiles(packageDirectory) {
  let entries;
  try {
    entries = await readdir(packageDirectory, { withFileTypes: true });
  } catch (error) {
    throw new ArtifactBudgetError(
      `Cannot read package directory: ${error.message}`,
    );
  }

  const allowedFiles = new Set([...PACKAGE_FILES, ...OPTIONAL_RELEASE_FILES]);
  for (const entry of entries) {
    if (!entry.isFile() || !allowedFiles.has(entry.name)) {
      throw new ArtifactBudgetError(`Unexpected package entry: ${entry.name}`);
    }
  }

  const files = {};
  for (const fileName of PACKAGE_FILES) {
    try {
      files[fileName] = await readFile(path.join(packageDirectory, fileName));
    } catch (error) {
      throw new ArtifactBudgetError(
        `Missing package file ${fileName}: ${error.message}`,
      );
    }
  }
  return files;
}

export async function measureArtifactPackage(
  packageDirectory = path.join(REPOSITORY_ROOT, "dist"),
) {
  const files = await readPackageFiles(packageDirectory);
  const mainSource = files["main.js"].toString("utf8");
  const workerSource = Buffer.from(extractEmbeddedWorker(mainSource), "utf8");
  const mainGzip = deterministicGzip(files["main.js"]);
  const stylesGzip = deterministicGzip(files["styles.css"]);

  return {
    schema: "ArtifactMeasurementV1",
    mainJsSha256: sha256(files["main.js"]),
    mainJsBytes: files["main.js"].byteLength,
    mainJsGzipBytes: mainGzip.byteLength,
    embeddedWorkerSha256: sha256(workerSource),
    embeddedWorkerBytes: workerSource.byteLength,
    stylesCssSha256: sha256(files["styles.css"]),
    stylesCssBytes: files["styles.css"].byteLength,
    stylesCssGzipBytes: stylesGzip.byteLength,
    packageChecksums: Object.fromEntries(
      PACKAGE_FILES.map((fileName) => [fileName, sha256(files[fileName])]),
    ),
  };
}

export function assertArtifactBudget(measurement, budget) {
  const checks = [
    ["mainJsBytes", "mainRawBytes"],
    ["mainJsGzipBytes", "mainGzipBytes"],
    ["embeddedWorkerBytes", "embeddedWorkerRawBytes"],
    ["stylesCssBytes", "stylesRawBytes"],
    ["stylesCssGzipBytes", "stylesGzipBytes"],
  ];
  for (const [measurementKey, budgetKey] of checks) {
    const value = measurement[measurementKey];
    const limit = budget.limits[budgetKey];
    if (value > limit) {
      throw new ArtifactBudgetError(
        `${measurementKey}=${value} exceeds ${budgetKey}=${limit}`,
      );
    }
  }
  return measurement;
}

async function main() {
  const budget = await loadArtifactBudget();
  const measurement = await measureArtifactPackage();
  assertArtifactBudget(measurement, budget);
  console.log(
    JSON.stringify({ ...measurement, budget: budget.schema }, null, 2),
  );
}

runAsCli(import.meta.url, main);
