import { describe, expect, it } from "vitest";

import { validatePathDataSteps } from "../../../src/persistence/documents/path-data-validator";
import { yieldToMainThread } from "../../../src/persistence/scheduling/main-thread-yield";
import { inspectTrustedSvgOutput } from "../../../src/persistence/scheduling/trusted-svg-output";
import {
  createMaximumComplexityPath,
  createMaximumComplexitySvg,
} from "../../fixtures/persistence/safe-svg";
import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { annotateDurations, expectProfileBudget, summarizeDurations } from "./metrics";

const MAIN_THREAD_BUDGET_MS = INTERACTION_REFRESH_PROFILE.mainThreadP99Ms;

describe("safe SVG validation performance", () => {
  it("validates a maximum-size, maximum-command path in bounded main-thread slices", async ({
    annotate,
  }) => {
    const output = createMaximumComplexitySvg();
    await measureValidation(output);
    const runs = [];
    for (let run = 0; run < 5; run += 1) runs.push(await measureValidation(output));
    const maximumSlices = runs.map(({ maximumSliceMs }) => maximumSliceMs);

    await annotateDurations(
      annotate,
      "maximum-complexity safe SVG validation slices",
      maximumSlices,
    );
    expectProfileBudget(maximumSlices, MAIN_THREAD_BUDGET_MS);
    expect(runs.every(({ checkpoints }) => checkpoints > 700)).toBe(true);
    expect(
      runs.every(({ checkpoints, syntheticInputSamples }) => syntheticInputSamples === checkpoints),
    ).toBe(true);
  }, 120_000);

  it("bounds actual path input reads and commands between generator checkpoints", () => {
    const path = createMaximumComplexityPath();
    const observed = observePathReads(path);
    // No deadline callback: fixed work bounds must hold on any processor.
    const steps = validatePathDataSteps(observed.input);
    let step;
    do {
      observed.reset();
      step = steps.next();
      const work = observed.work();
      // A numeric token and one lookahead may cross the 16 KiB boundary.
      expect(work.span).toBeLessThanOrEqual(16 * 1024 + 12);
      expect(work.reads).toBeLessThanOrEqual(64 * 1024);
      expect(work.commands).toBeLessThanOrEqual(256);
    } while (!step.done);
    const normal = validatePathDataSteps(path);
    let expected = normal.next();
    while (!expected.done) expected = normal.next();
    expect(step.value).toEqual(expected.value);
    expect(step.value).toEqual({ commands: 200_000, numericTokens: 400_000 });
  }, 120_000);
});

async function measureValidation(output: string): Promise<{
  readonly checkpoints: number;
  readonly maximumSliceMs: number;
  readonly syntheticInputSamples: number;
}> {
  const durations: number[] = [];
  let sliceStarted = performance.now();
  let checkpoints = 0;
  let syntheticInputSamples = 0;
  const trusted = await inspectTrustedSvgOutput(output, undefined, {
    checkpoint: async () => {
      durations.push(performance.now() - sliceStarted);
      checkpoints += 1;
      syntheticInputSamples += 1;
      await yieldToMainThread();
      sliceStarted = performance.now();
    },
    signal: new AbortController().signal,
  });
  durations.push(performance.now() - sliceStarted);
  expect(trusted.revision).toBe(3);
  return {
    checkpoints,
    maximumSliceMs: summarizeDurations(durations).maximum,
    syntheticInputSamples,
  };
}

/** Observes the real parser's indexed reads and token slices without emulating parsing. */
function observePathReads(path: string) {
  let minimum = Infinity;
  let maximum = -1;
  let reads = 0;
  const commands = new Set<number>();
  function record(start: number, end: number): void {
    minimum = Math.min(minimum, start);
    maximum = Math.max(maximum, end - 1);
    reads += end - start;
  }
  const input = new Proxy(
    {
      length: path.length,
      slice: (start: number, end: number) => {
        record(start, end);
        return path.slice(start, end);
      },
    },
    {
      get(target, key, receiver) {
        if (typeof key !== "string" || !/^\d+$/u.test(key)) {
          return Reflect.get(target, key, receiver) as unknown;
        }
        const index = Number(key);
        record(index, index + 1);
        const character = path[index];
        if (character === "M" || character === "L") commands.add(index);
        return character;
      },
    },
  ) as unknown as string;
  return {
    input,
    reset: () => {
      minimum = Infinity;
      maximum = -1;
      reads = 0;
      commands.clear();
    },
    work: () => ({ span: maximum < 0 ? 0 : maximum - minimum + 1, reads, commands: commands.size }),
  };
}
