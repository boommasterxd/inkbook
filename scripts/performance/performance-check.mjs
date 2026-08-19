import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertArtifactBudget,
  loadArtifactBudget,
  measureArtifactPackage,
} from "./artifact-budget.mjs";
import { validateEvidence } from "./performance-evidence.mjs";
import {
  PerformanceValidationError,
  validateProfileDraft,
  validateProfile,
} from "./performance-profile.mjs";
import { runAsCli } from "./cli.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const PROFILE_PATH = path.join(
  REPOSITORY_ROOT,
  "config/performance-profile.v1.json",
);
const GIT_EXECUTABLE = "/usr/bin/git";

function optionValue(args, option) {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function cleanCommit() {
  const dirtyFiles = execFileSync(
    GIT_EXECUTABLE,
    ["status", "--porcelain", "--untracked-files=all"],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    },
  ).trim();
  if (dirtyFiles) {
    throw new PerformanceValidationError(
      "Performance validation requires a clean checkout; the bundle and commit cannot be bound safely",
    );
  }
  return currentCommit();
}

function currentCommit() {
  return execFileSync(GIT_EXECUTABLE, ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim();
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (!mode || !["profile", "evidence"].includes(mode)) {
    throw new PerformanceValidationError(
      "Usage: performance-check.mjs <profile|evidence> [--evidence path] [--tag tag]",
    );
  }
  const budget = await loadArtifactBudget();
  const packageDirectory =
    optionValue(args, "--package") ?? path.join(REPOSITORY_ROOT, "dist");
  const artifact = await measureArtifactPackage(packageDirectory);
  assertArtifactBudget(artifact, budget);
  const profile = readJson(PROFILE_PATH);
  const bindProfile = profile.status === "final";
  const commit =
    bindProfile || mode === "evidence" ? cleanCommit() : currentCommit();
  if (bindProfile) {
    validateProfile(profile, { artifact, budget });
  } else {
    validateProfileDraft(profile, budget);
    validateProfile(profile, { artifact, budget });
  }
  if (mode === "profile") {
    console.log(
      `PerformanceProfileV1 ${bindProfile ? "bound" : "draft, not release evidence"} for ${commit} and ${artifact.mainJsSha256}`,
    );
    return;
  }

  const evidencePath = optionValue(args, "--evidence");
  if (!evidencePath)
    throw new PerformanceValidationError("Evidence path is required");
  let evidence;
  try {
    evidence = readJson(evidencePath);
  } catch (error) {
    throw new PerformanceValidationError(
      `Cannot read required performance evidence: ${error.message}`,
    );
  }
  validateEvidence(evidence, {
    profile,
    artifact,
    expectedCommit: commit,
    expectedTag: optionValue(args, "--tag"),
  });
  console.log(
    `PerformanceEvidenceV1 valid for ${evidence.tag}, ${commit}, and ${artifact.mainJsSha256}`,
  );
}

runAsCli(import.meta.url, main);
