import { afterEach, describe, expect, it, vi } from "vitest";

import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import * as windowJobs from "../../../../../src/domain/geometry/pressure/pressure-window";
import * as pressureWindows from "../../../../../src/domain/geometry/pressure/pressure-path-serialization";
import * as pressureOutline from "../../../../../src/domain/geometry/pressure/pressure-outline";
import * as simplification from "../../../../../src/domain/geometry/stroke-simplification";
import type { StrokeElementV1 } from "../../../../../src/domain/schema/public";
import { ProgressivePreviewPath } from "../../../../../src/rendering/scene/content/progressive-preview-path";
import { createAllElementSnapshot } from "../../../persistence/serialization/fixtures";
import { indexedStroke } from "../../../../fixtures/editor/stroke";

afterEach(() => vi.restoreAllMocks());

describe("progressive canonical preview geometry", () => {
  it.each([1, 2, 3, 59, 60, 61, 64, 127, 4096])(
    "matches the committed continuous pressure outline for %i pressure samples at every slice boundary",
    (count) => {
      const element = {
        ...indexedStroke(1),
        rotation: 37,
        points: Array.from({ length: count }, (_, index) => [
          20 + index * 0.1,
          30 + (index % 2) * 5,
          0.1 + (index % 9) / 10,
        ]).flat(),
      };
      const { job, step } = observeProgressivePath(element);
      const steps = completePreview(step, () => {
        expect(job.parts).toBeUndefined();
      });
      expect(job.parts).toEqual(buildElementPathParts(element));
      if (count === 4096) expect(steps).toBeGreaterThan(60);
    },
  );

  it.each([1, 2, 3, 59, 60, 61, 64, 127, 4096])(
    "keeps one byte-identical centerline across %i non-pressure samples",
    (count) => {
      for (const rotation of [0, 37]) {
        const base = indexedStroke(1);
        const element = {
          ...base,
          rotation,
          style: { ...base.style, pressureEnabled: false },
          points: Array.from({ length: count }, (_, index) => [
            20 + index * 0.1,
            30 + (index % 2),
            0.5,
          ]).flat(),
        };
        const { job, step } = observeProgressivePath(element);
        completePreview(step, () => {
          expect(job.parts).toBeUndefined();
        });
        expect(job.parts).toEqual(buildElementPathParts(element));
        expect(job.parts![0]!.d.match(/M/gu)).toHaveLength(1);
      }
    },
  );

  it("uses the canonical geometry builder for every non-pressure element kind", () => {
    for (const element of createAllElementSnapshot().elements) {
      if (element.kind === "stroke") element.style = { ...element.style, pressureEnabled: false };
      const job = new ProgressivePreviewPath(element);
      expect(job.step()).toBe(true);
      expect(job.parts).toEqual(buildElementPathParts(element));
    }
  });
});

function observeProgressivePath(element: StrokeElementV1) {
  let reads = 0;
  let minimum = Infinity;
  let maximum = -1;
  const source = new Proxy(element.points, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/u.test(key)) {
        const index = Math.floor(Number(key) / 3);
        reads += 1;
        minimum = Math.min(minimum, index);
        maximum = Math.max(maximum, index);
      }
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  const outlines = vi.spyOn(pressureOutline, "visitPreparedPressureOutline");
  const simplify = vi.spyOn(simplification, "simplifyStrokeCenters");
  const job = new ProgressivePreviewPath({ ...element, points: source });
  expect(reads).toBe(0);
  return {
    job,
    step: () => {
      reads = 0;
      minimum = Infinity;
      maximum = -1;
      outlines.mockClear();
      simplify.mockClear();
      const complete = job.step();
      expect(simplify.mock.calls.length).toBeLessThanOrEqual(1);
      for (const [source] of simplify.mock.calls) expect(source.length).toBeLessThanOrEqual(65);
      expect(outlines.mock.calls.length).toBeLessThanOrEqual(1);
      for (const [source, , , slice] of outlines.mock.calls) {
        expect(
          (slice?.lastBoundary ?? source.length - 1) - (slice?.firstBoundary ?? 0),
        ).toBeLessThanOrEqual(64);
      }
      // Retain the conservative raw-center read ceiling alongside the stricter
      // observed 65-center input and 64-interval contour-call bounds above.
      const maximumCenters = Math.min(element.points.length / 3, 66);
      // The contour phase reuses selected centers and no longer revisits the raw prefix.
      expect(reads).toBeLessThanOrEqual(Math.min(element.points.length / 3, 65) * 10);
      if (reads > 0) expect(maximum - minimum + 1).toBeLessThanOrEqual(maximumCenters);
      return complete;
    },
  };
}

it("releases smoothed centers and partial strings after completing canonical geometry", () => {
  const element = {
    ...indexedStroke(1),
    points: Array.from({ length: 4096 }, (_, index) => [index, index % 2, 0.5]).flat(),
  };
  const usage = vi.spyOn(pressureWindows, "pressureWindowMemoryUsage");
  const job = new ProgressivePreviewPath(element);
  expect(job.memoryUsage()).toBe(0);
  expect(job.step()).toBe(false);
  expect(job.memoryUsage()).toBeGreaterThan(0);
  completePreview(
    () => job.step(),
    () => {
      const retainedWindows = usage.mock.results.reduce(
        (bytes, result) => bytes + Number(result.value),
        0,
      );
      expect(job.memoryUsage()).toBeGreaterThanOrEqual(retainedWindows);
    },
  );
  expect(usage.mock.calls.length).toBeGreaterThan(0);
  expect(job.memoryUsage()).toBe(job.parts!.reduce((bytes, part) => bytes + part.d.length * 2, 0));
});

it("keeps completed path identity when stepped again", () => {
  const job = new ProgressivePreviewPath(indexedStroke(1));
  completePreview(() => job.step());
  const parts = job.parts;
  expect(job.step()).toBe(true);
  expect(job.parts).toBe(parts);
});

it("obeys the supplied deadline and releases its suspended-job reserve", () => {
  const original = windowJobs.preparePressureWindowSteps;
  let operations = 0;
  vi.spyOn(windowJobs, "preparePressureWindowSteps").mockImplementation(function* (pieces) {
    const job = original(pieces);
    for (;;) {
      operations++;
      const step = job.next();
      if (step.done) return step.value;
      yield;
    }
  });
  const element = {
    ...indexedStroke(1),
    points: Array.from({ length: 192 }, (_, i) => [i, i % 9, 0.5]).flat(),
  };
  const job = new ProgressivePreviewPath(element);
  let maximum = 0;
  completePreview(() => {
    const before = operations;
    job.step();
    maximum = Math.max(maximum, operations - before);
    // Window capacity and bounded generator operations govern uninterrupted work.
    return job.parts !== undefined;
  });
  expect(maximum).toBeGreaterThan(0);
  const deferred = new ProgressivePreviewPath(element);
  let elapsed = 0;
  let suspended = false;
  completePreview(() => {
    elapsed = 0;
    const before = operations;
    deferred.step(17, () => elapsed++);
    expect(operations - before).toBeLessThanOrEqual(18);
    if (operations - before >= 17 && deferred.parts === undefined) {
      suspended = true;
      expect(deferred.memoryUsage()).toBeGreaterThanOrEqual(
        windowJobs.PRESSURE_WINDOW_SCRATCH_BYTES,
      );
    }
    return deferred.parts !== undefined;
  });
  expect(suspended).toBe(true);
  expect(deferred.memoryUsage()).toBe(
    deferred.parts!.reduce((bytes, part) => bytes + part.d.length * 2, 0),
  );
  expect(job.parts).toEqual(buildElementPathParts(element));
});

it("keeps progressing past the former step quota while shared time remains", () => {
  const prepare = windowJobs.preparePressureWindowSteps;
  let operations = 0;
  vi.spyOn(windowJobs, "preparePressureWindowSteps").mockImplementation(function* (pieces) {
    for (let index = 0; index < 5000; index += 1) {
      operations += 1;
      yield;
    }
    return yield* prepare(pieces);
  });
  const job = new ProgressivePreviewPath(pressureWindowStroke());
  const clock = vi.fn(() => 0);
  completePreview(() => {
    job.step(1, clock);
    return operations > 0;
  });
  expect(operations).toBe(5000);
  job.cancel();
  expect(job.memoryUsage()).toBe(0);
});

it("reuses canonical pressure paths and windows without repeating their union", () => {
  const element = pressureWindowStroke();
  const windows = new Map<number, pressureWindows.PressureWindow>();
  const parts = buildElementPathParts(element, {
    readWindow: () => undefined,
    publishWindow: (index, window) => {
      windows.set(index, window);
    },
  });
  const prepare = vi.spyOn(windowJobs, "preparePressureWindowSteps");
  const publishPath = vi.fn();
  const port = {
    readWindow: (index: number) => windows.get(index),
    publishWindow: vi.fn(),
    publishPath,
  };
  const fromWindows = new ProgressivePreviewPath(element, port);
  completePreview(() => fromWindows.step());
  expect(fromWindows.parts).toEqual(parts);
  expect(prepare).not.toHaveBeenCalled();
  expect(port.publishWindow).not.toHaveBeenCalled();
  expect(publishPath).toHaveBeenCalledWith(fromWindows.parts);
  const fromPath = new ProgressivePreviewPath(element, { ...port, readPath: () => parts });
  expect(fromPath.parts).toBe(parts);
  expect(fromPath.step()).toBe(true);
  expect(prepare).not.toHaveBeenCalled();
});

it("uses the store's exact window measurement during progressive preparation", () => {
  const element = pressureWindowStroke();
  const measurement = vi.spyOn(pressureWindows, "pressureWindowMemoryUsage");
  const windows: pressureWindows.PressureWindow[] = [];
  const job = new ProgressivePreviewPath(element, {
    readWindow: () => undefined,
    publishWindow: (_index, window) => {
      windows.push(window);
      return { window, numericBytes: pressureWindows.pressureWindowMemoryUsage(window) };
    },
  });
  completePreview(() => job.step());
  expect(windows.length).toBeGreaterThan(0);
  expect(measurement).toHaveBeenCalledTimes(windows.length);
  expect(job.parts).toEqual(buildElementPathParts(element));
});

it("recounts a pressure window when a port reports another window's measurement", () => {
  const usage = vi.spyOn(pressureWindows, "pressureWindowMemoryUsage");
  let published = 0;
  const job = new ProgressivePreviewPath(pressureWindowStroke(), {
    readWindow: () => undefined,
    publishWindow: () => {
      published += 1;
      return { window: { kind: "window", additions: [], loops: [] }, numericBytes: 0 };
    },
  });
  completePreview(() => job.step());
  expect(published).toBeGreaterThan(0);
  expect(usage).toHaveBeenCalledTimes(published);
});

it("cancels a suspended pressure union and releases every derived buffer", () => {
  const element = pressureWindowStroke();
  const prepare = vi.spyOn(windowJobs, "preparePressureWindowSteps");
  const job = new ProgressivePreviewPath(element);
  completePreview(() => {
    job.step(0, () => 1);
    return prepare.mock.calls.length > 0;
  });
  expect(job.memoryUsage()).toBeGreaterThanOrEqual(windowJobs.PRESSURE_WINDOW_SCRATCH_BYTES);
  const iterator = prepare.mock.results[0]!.value as Generator;
  const resume = vi.spyOn(iterator, "next");
  const close = vi.spyOn(iterator, "return");
  job.cancel();
  expect(close).toHaveBeenCalledOnce();
  expect(job.memoryUsage()).toBe(0);
  expect(job.step()).toBe(false);
  expect(resume).not.toHaveBeenCalled();
  expect(job.parts).toBeUndefined();
});

function pressureWindowStroke(): StrokeElementV1 {
  return {
    ...indexedStroke(1),
    points: Array.from({ length: 192 }, (_, i) => [i, i % 7, (i % 9) / 10]).flat(),
  };
}

function completePreview(step: () => boolean, onPending: () => void = () => undefined): number {
  // Match the coarse reconciler-drain safety cap; this is not a performance budget.
  for (let steps = 1; steps <= 10_000; steps += 1) {
    if (step()) return steps;
    onPending();
  }
  throw new Error("Preview preparation did not settle within 10,000 steps.");
}
