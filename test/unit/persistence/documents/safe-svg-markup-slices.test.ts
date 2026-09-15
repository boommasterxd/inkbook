import { describe, expect, it } from "vitest";

import {
  validateSafeSvg,
  validateSafeSvgSteps,
} from "../../../../src/persistence/documents/safe-svg-validator";
import {
  createMaximumComplexitySvg,
  exhaustValidation,
} from "../../../fixtures/persistence/safe-svg";

const SCAN_BOUNDARY = 256 * 1024;

describe("bounded unsupported SVG markup inspection", () => {
  // Both full-capacity validation paths run under coverage; slice latency is tested separately.
  it("yields while scanning a maximum path without changing its validation result", () => {
    const svg = createMaximumComplexitySvg();
    const steps = validateSafeSvgSteps(svg, { totalInputBytes: svg.length });
    expect(steps.next().done).toBe(false);
    const { result, yields } = exhaustValidation(steps);
    expect(result).toEqual(validateSafeSvg(svg));
    expect(result).toMatchObject({ revision: 3, pathCommands: 200_000 });
    expect(yields).toBeGreaterThan(700);
  }, 15_000);

  it.each(["<!", "<?"])("rejects %s before, across, and after scan boundaries", (marker) => {
    const svg = createMaximumComplexitySvg();
    for (const boundary of [SCAN_BOUNDARY, SCAN_BOUNDARY * 2]) {
      for (const offset of [-2, -1, 0, 1]) {
        const position = boundary + offset;
        const input = `${svg.slice(0, position)}${marker}${svg.slice(position + marker.length)}`;
        expect(
          exhaustValidation(validateSafeSvgSteps(input, { totalInputBytes: input.length })),
        ).toEqual({ result: null, yields: Math.floor(position / SCAN_BOUNDARY) });
        expect(validateSafeSvg(input)).toBeNull();
      }
    }
  });

  it("rejects unsupported markup at the end after earlier scan slices yielded", () => {
    const input = `${createMaximumComplexitySvg()}<?`;
    const { result, yields } = exhaustValidation(
      validateSafeSvgSteps(input, { totalInputBytes: input.length }),
    );
    expect(yields).toBeGreaterThan(1);
    expect(result).toBeNull();
  });
});
