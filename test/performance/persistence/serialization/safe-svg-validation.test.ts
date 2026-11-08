import { describe, expect, it, vi } from "vitest";

import { validatePathDataSteps } from "../../../../src/persistence/documents/path-data-validator";
import { inspectTrustedSvgOutput } from "../../../../src/persistence/scheduling/trusted-svg-output";
import { validateSafeSvgSteps } from "../../../../src/persistence/documents/safe-svg-validator";
import { serializeSvgEnvelope } from "../../../../src/persistence/documents/svg-envelope";
import { createWorkerSnapshot } from "../../../fixtures/persistence/worker-snapshot";
import { createCapacityExportSvg } from "../../../fixtures/persistence/export-geometry";
import {
  createMaximumComplexityPath,
  createMaximumComplexitySvg,
  exhaustValidation,
} from "../../../fixtures/persistence/safe-svg";
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
    expect(step.value).toEqual({ commands: 400_000, numericTokens: 800_000 });
  }, 120_000);
});

describe("safe SVG metadata work", () => {
  it("encodes the raw metadata of 10,000 strokes once while retaining complete validation", () => {
    const svg = createCapacityExportSvg();
    const start = svg.indexOf(">", svg.indexOf("<metadata")) + 1;
    const raw = svg.slice(start, svg.indexOf("</metadata>"));
    const expectedBytes = new TextEncoder().encode(raw).byteLength;
    const observed = observeMetadataEncoding(svg, svg.length);
    expect(observed.result).toMatchObject({ paths: 10_001, metadataBytes: expectedBytes });
    expect(observed.result!.metadataText).toBe(raw);
    expect(observed.encodedCodeUnits).toBe(raw.length);
    expect(observed.boundedEncoderWrites).toBe(true);
  });

  it("counts escaped Unicode once and derives exact decoded bytes across both chunk boundaries", () => {
    const prefix = `${"a".repeat(16 * 1024 - 1)}&amp;`.padEnd(256 * 1024 - 1, "a");
    const raw = `${prefix}😀${"ä😀".repeat(40_000)}&lt;&gt;&amp;`;
    const decoded = `${prefix.replace("&amp;", "&")}😀${"ä😀".repeat(40_000)}<>&`;
    const base = serializeSvgEnvelope(createWorkerSnapshot([]), 100, {
      background: [],
      highlights: [],
      content: [],
    });
    const start = base.indexOf(">", base.indexOf("<metadata")) + 1;
    const svg = base.slice(0, start) + raw + base.slice(base.indexOf("</metadata>"));
    const totalInputBytes = new TextEncoder().encode(svg).byteLength;
    const expectedBytes = new TextEncoder().encode(decoded).byteLength;
    const observed = observeMetadataEncoding(svg, totalInputBytes);
    expect(observed.result?.metadataText).toBe(decoded);
    expect(observed.result?.metadataBytes).toBe(expectedBytes);
    expect(observed.encodedCodeUnits).toBe(raw.length);
    expect(observed.boundedEncoderWrites).toBe(true);
    expect(observed.yields).toBeGreaterThan(20);
  });
});

function observeMetadataEncoding(svg: string, totalInputBytes: number) {
  const encode = vi.spyOn(TextEncoder.prototype, "encode");
  try {
    const validation = exhaustValidation(validateSafeSvgSteps(svg, { totalInputBytes }));
    return {
      ...validation,
      encodedCodeUnits: encode.mock.calls.reduce((sum, [input]) => sum + (input?.length ?? 0), 0),
      boundedEncoderWrites: encode.mock.calls.every(([input]) => input!.length <= 256 * 1024),
    };
  } finally {
    encode.mockRestore();
  }
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
