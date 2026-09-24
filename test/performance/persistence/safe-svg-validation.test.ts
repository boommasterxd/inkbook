import { describe, expect, it } from "vitest";

import { validatePathDataSteps } from "../../../src/persistence/documents/path-data-validator";
import { inspectTrustedSvgOutput } from "../../../src/persistence/scheduling/trusted-svg-output";
import {
  createMaximumComplexityPath,
  createMaximumComplexitySvg,
} from "../../fixtures/persistence/safe-svg";
describe("safe SVG validation performance", () => {
  it("validates a maximum-size, maximum-command path with cooperative checkpoints", async () => {
    let checkpoints = 0;
    const trusted = await inspectTrustedSvgOutput(createMaximumComplexitySvg(), undefined, {
      checkpoint: async () => {
        checkpoints += 1;
      },
      signal: new AbortController().signal,
    });
    expect(trusted.revision).toBe(3);
    expect(checkpoints).toBeGreaterThan(700);
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
    expect(step.value).toEqual({ commands: 400_000, numericTokens: 800_000 });
  }, 120_000);
});

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
