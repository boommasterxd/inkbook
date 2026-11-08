import { describe, expect, it } from "vitest";
import {
  chooseExportCut,
  prepareExportCutsSteps,
  type ExportInterval,
} from "../../../../src/domain/export/export-pagination";

function prepare(intervals: readonly ExportInterval[]) {
  const steps = prepareExportCutsSteps(intervals);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

const defaults = { start: 0, limit: 100, minimum: 20, lookback: 40 };

describe("export pagination bounds heuristic", () => {
  it("keeps a nearly fitting embed on the current page and chooses the latest clear boundary", () => {
    const cuts = prepare([
      { minY: 10, maxY: 60 },
      { minY: 90, maxY: 120 },
    ]);
    expect(chooseExportCut(cuts, defaults)).toBe(90);
    expect(chooseExportCut(cuts, { ...defaults, limit: 130 })).toBe(130);
  });

  it("minimizes crossings when an oversized object cannot stay whole", () => {
    const cuts = prepare([
      { minY: -100, maxY: 400 },
      { minY: 80, maxY: 110 },
      { minY: 85, maxY: 130 },
    ]);
    expect(chooseExportCut(cuts, defaults)).toBe(80);
    expect(chooseExportCut(cuts, { ...defaults, start: 100, limit: 200 })).toBe(200);
  });

  it("does not mistake touching endpoints for a clear strip of paper", () => {
    const cuts = prepare([
      { minY: -10, maxY: 75 },
      { minY: 75, maxY: 150 },
      { minY: 50, maxY: 50 },
    ]);
    expect(chooseExportCut(cuts, defaults)).toBe(100);
    expect(chooseExportCut(cuts, { ...defaults, limit: 75 })).toBe(75);
  });

  it("leaves antialiasing clearance before a stroke instead of duplicating a tangent pixel", () => {
    const cuts = prepare([
      { minY: 10, maxY: 60 },
      { minY: 90, maxY: 120 },
    ]);
    expect(chooseExportCut(cuts, { ...defaults, clearance: 3 })).toBe(87);
    expect(chooseExportCut(cuts, { ...defaults, limit: 90, clearance: 3 })).toBe(87);
  });

  it.each([
    { limit: 294.872, expected: 294.872 },
    { limit: 474.872, expected: 295 },
    { limit: 500.2308727272727, expected: 295 },
  ])("keeps a small rectangle whole at page limit $limit", ({ limit, expected }) => {
    const cuts = prepare([
      { minY: 0, maxY: 200 },
      { minY: 298, maxY: 502 },
    ]);
    expect(
      chooseExportCut(cuts, {
        start: 0,
        limit,
        minimum: 100,
        lookback: limit * 0.3,
        clearance: 3,
      }),
    ).toBe(expected);
  });

  it("retains the bounded result when an earlier cut still crosses an oversized object", () => {
    const cuts = prepare([
      { minY: -100, maxY: 400 },
      { minY: 60, maxY: 110 },
      { minY: 80, maxY: 130 },
    ]);
    expect(chooseExportCut(cuts, { ...defaults, lookback: 30 })).toBe(80);
  });

  it("rejects an earlier clearance shift into ink when the minimum excludes its clear side", () => {
    const cuts = prepare([{ minY: 20, maxY: 150 }]);
    expect(chooseExportCut(cuts, { ...defaults, clearance: 3 })).toBe(100);
  });

  it("extends lookback only for a clear cut while preserving minimum height and progress", () => {
    const cuts = prepare([
      { minY: 10, maxY: 60 },
      { minY: 80, maxY: 200 },
    ]);
    expect(chooseExportCut(cuts, { ...defaults, minimum: 90 })).toBe(100);
    expect(chooseExportCut(cuts, { ...defaults, lookback: 10 })).toBe(80);
    expect(chooseExportCut(cuts, { ...defaults, minimum: 110 })).toBe(100);
    expect(chooseExportCut(cuts, { ...defaults, start: 80, minimum: 0 })).toBe(100);
  });

  it("handles empty documents and negative document coordinates", () => {
    expect(chooseExportCut(prepare([]), defaults)).toBe(100);
    const cuts = prepare([{ minY: -30, maxY: 10 }]);
    expect(chooseExportCut(cuts, { start: -100, limit: 0, minimum: 1, lookback: 100 })).toBe(-30);
  });

  it("rejects invalid intervals and invalid page limits", () => {
    expect(() => prepare([{ minY: 20, maxY: 10 }])).toThrow(RangeError);
    expect(() => prepare([{ minY: NaN, maxY: 10 }])).toThrow(RangeError);
    expect(() => chooseExportCut(prepare([]), { ...defaults, limit: 0 })).toThrow(RangeError);
    expect(() => chooseExportCut(prepare([]), { ...defaults, lookback: -1 })).toThrow(RangeError);
  });
});
