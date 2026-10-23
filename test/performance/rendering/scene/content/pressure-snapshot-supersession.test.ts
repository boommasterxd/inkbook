import { afterEach, describe, expect, it, vi } from "vitest";
import * as pressureWindows from "../../../../../src/domain/geometry/pressure/pressure-window";
import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import { ProgressivePreviewPath } from "../../../../../src/rendering/scene/content/progressive-preview-path";
import {
  createProgressivePreviewFixture,
  createLongPreviewStroke,
  observePressurePreviewSteps,
} from "../../../../fixtures/rendering/progressive-element-preview";
import { createMultiWindowPressureStroke } from "../../../../fixtures/persistence/worker-snapshot";

afterEach(() => vi.restoreAllMocks());

describe("pressure snapshot supersession work", () => {
  it("cancels obsolete unions, coalesces input, and completes only settled current geometry", () => {
    const { content, preview } = createProgressivePreviewFixture();
    let element = createMultiWindowPressureStroke();
    const ids = [element.id];
    const feedbackIds = [...ids, createLongPreviewStroke(2).id];
    const { steps, windows, writeNext } = observePressurePreviewSteps();
    const materialize = vi.fn(() => element);
    const request = (version: number) => ({
      ids,
      feedbackIds,
      version,
      materialize,
      feedback: {
        transform: `scale(${String(version + 1)} 1)`,
        inverse: `scale(${String(1 / (version + 1))} 1)`,
      },
    });
    preview.set(request(1));
    while (windows.mock.calls.length === 0) writeNext(preview);
    expect(preview.memoryUsage()).toBeGreaterThanOrEqual(
      pressureWindows.PRESSURE_WINDOW_SCRATCH_BYTES,
    );
    const oldPath = steps.mock.contexts[0] as ProgressivePreviewPath;
    const old = windows.mock.results[0]!.value as Generator;
    const resume = vi.spyOn(old, "next");
    const close = vi.spyOn(old, "return");
    materialize.mockClear();
    for (let version = 2; version <= 8; version += 1) {
      element = {
        ...element,
        points: element.points.map((value, index) => (index % 3 === 1 ? value + 1 : value)),
      };
      for (let sample = 0; sample < 4; sample += 1) preview.set(request(version));
      expect(materialize).toHaveBeenCalledTimes(version - 2);
      preview.writeFeedback(2, Infinity, () => 0);
      writeNext(preview);
      expect(materialize).toHaveBeenCalledTimes(version - 1);
      expect(content.applyPreviewTransform).toHaveBeenLastCalledWith(
        feedbackIds[1],
        `scale(${String(version + 1)} 1)`,
        version,
        2,
      );
    }
    expect(resume).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(oldPath.memoryUsage()).toBe(0);
    expect(oldPath.step()).toBe(false);
    expect(content.applyCanonicalElementPreview).not.toHaveBeenCalled();
    steps.mockRestore();
    expect(preview.write(Infinity, () => 0)).toBe(false);
    expect(content.applyCanonicalElementPreview).toHaveBeenCalledExactlyOnceWith(
      element,
      buildElementPathParts(element),
    );
    preview.clear();
    expect(preview.memoryUsage()).toBe(0);
  });
});
