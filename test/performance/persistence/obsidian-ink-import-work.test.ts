import { afterEach, describe, expect, it, vi } from "vitest";
import * as canonical from "../../../src/domain/schema/canonical";
import * as primitives from "../../../src/domain/geometry/primitives";
import * as strokePath from "../../../src/domain/geometry/stroke-path";
import { convertObsidianInk } from "../../../src/persistence/import/obsidian-ink/convert";
import * as strokeGeometry from "../../../src/persistence/import/obsidian-ink/stroke-geometry";
import {
  canvasSnapshot,
  canvasStroke,
  inkSvg,
} from "../../unit/persistence/import/obsidian-ink/fixtures";

afterEach(() => vi.restoreAllMocks());

describe("Obsidian Ink import resource bounds", () => {
  it("imports the required 10000-stroke document while bounding geometry work between central checkpoints", async () => {
    const source = inkSvg(
      canvasSnapshot({
        strokes: Array.from({ length: 10_000 }, (_, index) => canvasStroke(`stroke-${index}`)),
      }),
    );
    let callsInSlice = 0;
    let maximumCalls = 0;
    let geometryCalls = 0;
    const original = canonical.canonicalizeGeometryNumber;
    vi.spyOn(canonical, "canonicalizeGeometryNumber").mockImplementation((value) => {
      callsInSlice += 1;
      geometryCalls += 1;
      return original(value);
    });
    const imported = await convertObsidianInk(source, {
      timestamp: 100,
      signal: new AbortController().signal,
      checkpoint: () => {
        maximumCalls = Math.max(maximumCalls, callsInSlice);
        callsInSlice = 0;
        return undefined;
      },
    });
    maximumCalls = Math.max(maximumCalls, callsInSlice);
    expect(imported.snapshot.elements).toHaveLength(10_000);
    const sampleBuffers = imported.snapshot.elements.map((element) => {
      if (element.kind !== "stroke") throw new Error("Expected imported handwriting.");
      expect(element.points).toHaveLength(6);
      return element.points;
    });
    expect(new Set(sampleBuffers).size).toBe(10_000);
    expect(sampleBuffers.reduce((sum, points) => sum + points.length, 0)).toBe(60_000);
    expect(geometryCalls).toBeGreaterThanOrEqual(40_000);
    // Target headers are bounded; schema validation admits at most 128 small strokes per step.
    expect(maximumCalls).toBeLessThanOrEqual(4096);
    expect(imported.warnings.length).toBeLessThanOrEqual(100);
  });
});

describe("Obsidian Ink curve fitting resource bounds", () => {
  it("bounds source-curve fitting and retained samples for a long curved stroke", async () => {
    const count = 4096;
    const stroke = canvasStroke();
    stroke.points = Array.from({ length: count }, (_, index) => [
      index * 2,
      Math.sin(index / 128) * 2,
      0.5,
    ]);
    let inSlice = 0;
    let maximum = 0;
    const center = strokePath.strokeCenterAt;
    const distance = primitives.pointSegmentDistance;
    const sqrt = Math.sqrt;
    const hypot = Math.hypot;
    const sin = Math.sin;
    const centers = vi.spyOn(strokePath, "strokeCenterAt").mockImplementation((...args) => {
      inSlice += 1;
      return center(...args);
    });
    const distances = vi.spyOn(primitives, "pointSegmentDistance").mockImplementation((...args) => {
      inSlice += 1;
      return distance(...args);
    });
    const roots = vi.spyOn(Math, "sqrt").mockImplementation((value) => {
      inSlice += 1;
      return sqrt(value);
    });
    const lengths = vi.spyOn(Math, "hypot").mockImplementation((...values) => {
      inSlice += 1;
      return hypot(...values);
    });
    const pressureResponses = vi.spyOn(Math, "sin").mockImplementation((value) => {
      inSlice += 1;
      return sin(value);
    });
    const imported = await convertObsidianInk(inkSvg(canvasSnapshot({ strokes: [stroke] })), {
      timestamp: 100,
      signal: new AbortController().signal,
      checkpoint: () => {
        maximum = Math.max(maximum, inSlice);
        inSlice = 0;
        return undefined;
      },
    });
    maximum = Math.max(maximum, inSlice);
    const converted = imported.snapshot.elements[0]!;
    if (converted.kind !== "stroke") throw new Error("Expected an imported stroke.");
    expect(converted.points.length).toBeLessThanOrEqual(count * 3);
    // This densely sampled curve needs one native-filter pass and no subdivision.
    expect(centers.mock.calls.length).toBeLessThanOrEqual(count);
    expect(distances.mock.calls.length).toBeLessThanOrEqual(count);
    expect(lengths.mock.calls.length).toBeLessThanOrEqual(count);
    // Source pressure widths are scanned and remapped once before curve construction.
    expect(pressureResponses.mock.calls.length).toBeLessThanOrEqual(2 * count + 1);
    expect(pressureResponses).toHaveBeenCalled();
    // Each edge checks at most five neighboring capsules in each direction;
    // every capsule uses at most two circle roots and one body-length root;
    // each quadratic flatness check adds one point-distance root.
    expect(roots.mock.calls.length).toBeLessThanOrEqual(30 * count + distances.mock.calls.length);
    expect(centers).toHaveBeenCalled();
    expect(distances).toHaveBeenCalled();
    expect(lengths).toHaveBeenCalled();
    expect(roots).toHaveBeenCalled();
    expect(maximum).toBeLessThanOrEqual(30);
  });
});

describe("Obsidian Ink import cancellation and capacity", () => {
  it("stops curve fitting after cancellation at a suspended central checkpoint", async () => {
    const controller = new AbortController();
    let geometryCalls = 0;
    const original = canonical.canonicalizeGeometryNumber;
    vi.spyOn(canonical, "canonicalizeGeometryNumber").mockImplementation((value) => {
      geometryCalls += 1;
      return original(value);
    });
    const distances = vi.spyOn(primitives, "pointSegmentDistance");
    const centers = vi.spyOn(strokePath, "strokeCenterAt");
    const roots = vi.spyOn(Math, "sqrt");
    const stroke = canvasStroke();
    stroke.points = [
      [0, 100, 0.25],
      [0, 0, 0.5],
      [100, 100, 0.75],
      [100, 0, 1],
    ];
    let release: (() => void) | undefined;
    let announce: (() => void) | undefined;
    const suspended = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const pending = convertObsidianInk(inkSvg(canvasSnapshot({ strokes: [stroke] })), {
      timestamp: 100,
      signal: controller.signal,
      checkpoint: () => {
        if (distances.mock.calls.length === 0) return undefined;
        announce?.();
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    await suspended;
    const admittedCalls = geometryCalls;
    const admittedDistances = distances.mock.calls.length;
    const admittedCenters = centers.mock.calls.length;
    const admittedRoots = roots.mock.calls.length;
    controller.abort(new Error("cancel conversion"));
    release?.();
    await expect(pending).rejects.toThrow("cancel conversion");
    expect(geometryCalls).toBe(admittedCalls);
    expect(distances).toHaveBeenCalledTimes(admittedDistances);
    expect(centers).toHaveBeenCalledTimes(admittedCenters);
    expect(roots).toHaveBeenCalledTimes(admittedRoots);
  });

  it("rejects oversized text before admitting any parse or conversion work", async () => {
    const checkpoint = vi.fn(() => undefined);
    await expect(
      convertObsidianInk(" ".repeat(16 * 1024 * 1024 + 1), {
        timestamp: 100,
        checkpoint,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "capacity-exceeded" });
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("enforces the native maximum stroke capacity before allocating an output point array", async () => {
    const stroke = canvasStroke();
    stroke.points = Array.from({ length: 16_385 }, () => [1, 2, 0.5]);
    const converted = vi.spyOn(canonical, "canonicalizeGeometryNumber");
    const fitted = vi.spyOn(strokeGeometry, "sampleSourceStrokeCurveSteps");
    await expect(
      convertObsidianInk(inkSvg(canvasSnapshot({ strokes: [stroke] })), {
        timestamp: 100,
        signal: new AbortController().signal,
        checkpoint: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "capacity-exceeded" });
    expect(converted).not.toHaveBeenCalled();
    expect(fitted).not.toHaveBeenCalled();
  });
});
