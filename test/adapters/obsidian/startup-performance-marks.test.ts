import { describe, expect, it, vi } from "vitest";

import {
  createStartupPerformanceMarks,
  markModuleEvaluated,
  STARTUP_PERFORMANCE_MARKS,
  type PerformanceMarkHost,
} from "../../../src/adapters/obsidian/startup-performance-marks";

const MODULE_CLEAR_CALL_COUNT = 7;
const INSTANCE_MARK_COUNT = 5;
const MARK_CLEAR_CALLS_PER_INSTANCE_MARK = 2;
const EVENT_CALL_INDEX = Object.freeze({
  onloadEntered: 1,
  onloadSettled: 2,
  onunloadEntered: 3,
  disposalSettled: 4,
  workerProbeSettled: 5,
});

function createTimeline(): PerformanceMarkHost & {
  readonly clearMarks: ReturnType<typeof vi.fn>;
  readonly mark: ReturnType<typeof vi.fn>;
} {
  const clearMarks = vi.fn<(name?: string) => void>();
  const mark = vi.fn<(name: string) => PerformanceMark>(
    (name) => ({ name }) as PerformanceMark,
  );
  return {
    performance: { clearMarks, mark },
    clearMarks,
    mark,
  };
}

describe("startup performance marks", () => {
  it("clears the bounded lifecycle set before marking a fresh module evaluation", () => {
    const timeline = createTimeline();

    markModuleEvaluated(timeline);

    expect(timeline.clearMarks).toHaveBeenCalledTimes(MODULE_CLEAR_CALL_COUNT);
    expect(timeline.clearMarks).toHaveBeenCalledWith(
      STARTUP_PERFORMANCE_MARKS.moduleEvaluated,
    );
    expect(timeline.mark).toHaveBeenCalledWith(
      STARTUP_PERFORMANCE_MARKS.moduleEvaluated,
    );
  });

  it("keeps one current lifecycle mark per event and never requires host timing APIs", () => {
    const timeline = createTimeline();

    const marks = createStartupPerformanceMarks(timeline);
    marks.markOnloadEntered();
    marks.markOnloadSettled();
    marks.markOnunloadEntered();
    marks.markDisposalSettled({
      resourceCoordinator: { balanced: true, disposed: true },
    });
    marks.markWorkerProbeSettled({
      workerLaunched: true,
      workerResultPassed: true,
      recoveryPassed: true,
      workerResourcesReleased: true,
    });

    expect(timeline.clearMarks).toHaveBeenCalledTimes(
      INSTANCE_MARK_COUNT * MARK_CLEAR_CALLS_PER_INSTANCE_MARK,
    );
    expect(timeline.mark).toHaveBeenNthCalledWith(
      EVENT_CALL_INDEX.onloadEntered,
      STARTUP_PERFORMANCE_MARKS.onloadEntered,
    );
    expect(timeline.mark).toHaveBeenNthCalledWith(
      EVENT_CALL_INDEX.onloadSettled,
      STARTUP_PERFORMANCE_MARKS.onloadSettled,
    );
    expect(timeline.mark).toHaveBeenNthCalledWith(
      EVENT_CALL_INDEX.onunloadEntered,
      STARTUP_PERFORMANCE_MARKS.onunloadEntered,
    );
    expect(timeline.mark).toHaveBeenNthCalledWith(
      EVENT_CALL_INDEX.disposalSettled,
      STARTUP_PERFORMANCE_MARKS.disposalSettled,
      { detail: { resourceCoordinator: { balanced: true, disposed: true } } },
    );
    expect(timeline.mark).toHaveBeenNthCalledWith(
      EVENT_CALL_INDEX.workerProbeSettled,
      STARTUP_PERFORMANCE_MARKS.workerProbeSettled,
      {
        detail: {
          workerLaunched: true,
          workerResultPassed: true,
          recoveryPassed: true,
          workerResourcesReleased: true,
        },
      },
    );
  });

  it("degrades to no-op marks when the browser timeline is unavailable", () => {
    expect(() => markModuleEvaluated({})).not.toThrow();
    const marks = createStartupPerformanceMarks({});

    expect(() => {
      marks.markOnloadEntered();
      marks.markOnloadSettled();
      marks.markOnunloadEntered();
      marks.markDisposalSettled({
        resourceCoordinator: { balanced: false, disposed: false },
      });
      marks.markWorkerProbeSettled({
        workerLaunched: false,
        workerResultPassed: false,
        recoveryPassed: false,
        workerResourcesReleased: false,
      });
    }).not.toThrow();
  });
});
