import { describe, expect, it } from "vitest";

import {
  validateDashArray,
  validatePathDataSteps,
} from "../../../../src/persistence/documents/path-data-validator";
import {
  createMaximumComplexityPath,
  MAXIMUM_PATH_BYTES,
} from "../../../fixtures/persistence/safe-svg";

const validatePathData = (path: string) => complete(validatePathDataSteps(path));

describe("safe SVG path data validation", () => {
  it.each([
    "M 0 0 Z",
    "M0 0 L10 20",
    "M 0 0 Q 1.25 2 3 4",
    "M 0 0 C 1 2 3 4 5 6",
    "M 0 0 A 10 20 0 0 1 50 60",
  ])("accepts allowlisted canonical path data: %s", (path) => {
    expect(validatePathData(path)).not.toBeNull();
  });

  it.each([
    "m 0 0",
    "L 0 0",
    "M 1e2 0",
    "M +1 0",
    "M 01 0",
    "M 0.0000 0",
    "M 0.000 0",
    "M -0 0",
    "M 1000001 0",
    "M 0 0 A 0 1 0 0 1 2 2",
    "M 0 0 A 1 1 10 0 1 2 2",
    "M 0 0 A 1 1 0 2 1 2 2",
    "M 0 0 Z L 1 1",
    "M 0 0 X 1 1",
  ])("rejects unsafe or noncanonical path data: %s", (path) => {
    expect(validatePathData(path)).toBeNull();
  });

  it("reports exact command and numeric-token counts", () => {
    expect(validatePathData("M 0 0 L 1 2 Z")).toEqual({ commands: 3, numericTokens: 4 });
  });

  it("resumes one maximum-size, maximum-command path across bounded byte and command slices", () => {
    const steps = validatePathDataSteps(createMaximumComplexityPath());
    let yielded = 0;
    let step = steps.next();
    while (!step.done) {
      expect(step.value).toBeUndefined();
      yielded += 1;
      step = steps.next();
    }

    expect(yielded).toBeGreaterThan(70);
    expect(step.value).toEqual({ commands: 20_000, numericTokens: 40_000 });
  });

  it("honors a deadline within one path without exposing a partial validation", () => {
    let deadlineChecks = 0;
    const steps = validatePathDataSteps(createMaximumComplexityPath(), {
      bytesPerStep: Number.MAX_SAFE_INTEGER,
      commandsPerStep: Number.MAX_SAFE_INTEGER,
      deadlineExceeded: () => {
        deadlineChecks += 1;
        return true;
      },
    });

    const first = steps.next();
    expect(first).toEqual({ done: false, value: undefined });
    expect(deadlineChecks).toBe(1);
    expect(complete(steps)).toEqual({ commands: 20_000, numericTokens: 40_000 });
  });

  it("rejects late invalid data after prior slices without accepting an intermediate result", () => {
    const path = `${createMaximumComplexityPath().slice(0, -1)}X`;
    const steps = validatePathDataSteps(path);
    const first = steps.next();

    expect(first).toEqual({ done: false, value: undefined });
    expect(complete(steps)).toBeNull();
  });

  it("preserves the exact per-path byte and command limits", () => {
    expect(validatePathData(createMaximumComplexityPath())).not.toBeNull();
    expect(validatePathData(`M 0 0${" L 1 1".repeat(20_000)}`)).toBeNull();
    expect(validatePathData("M 0 0".padEnd(MAXIMUM_PATH_BYTES + 1, " "))).toBeNull();
  });
});

function complete<T>(steps: Generator<void, T>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

describe("dash array validation", () => {
  it.each(["0 20", "4,3", "0 0.001", "255.999 256", "1 2 3 4 5 6 7 8"])(
    "accepts bounded canonical nonzero dash array %s",
    (value) => {
      expect(validateDashArray(value)).toBe(true);
    },
  );

  it.each([
    "0",
    "0 0",
    "-0 2",
    "-1 2",
    "256.001 1",
    "257 1",
    ".5 2",
    "01 2",
    "00.001 2",
    "0.000 2",
    "0.0001 2",
    "1.2345 2",
    "1e2 2",
    "NaN 2",
    "Infinity 2",
    "1 2 3 4 5 6 7 8 9",
  ])("rejects invalid dash array %s", (value) => {
    expect(validateDashArray(value)).toBe(false);
  });
});
