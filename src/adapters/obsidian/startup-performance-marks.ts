export const STARTUP_PERFORMANCE_MARKS = Object.freeze({
  moduleEvaluated: "inkbook.lifecycle.module-evaluated",
  onloadEntered: "inkbook.lifecycle.onload-entered",
  onloadSettled: "inkbook.lifecycle.onload-settled",
  onunloadEntered: "inkbook.lifecycle.onunload-entered",
  disposalSettled: "inkbook.lifecycle.disposal-settled",
  workerProbeSettled: "inkbook.lifecycle.worker-probe-settled",
} as const);

const LIFECYCLE_MARKS = Object.freeze(Object.values(STARTUP_PERFORMANCE_MARKS));
const INSTANCE_MARKS = Object.freeze(
  LIFECYCLE_MARKS.filter(
    (name) => name !== STARTUP_PERFORMANCE_MARKS.moduleEvaluated,
  ),
);

export interface PerformanceMarkHost {
  readonly performance?: Pick<Performance, "clearMarks" | "mark">;
}

interface DisposalSettledMarkDetail {
  readonly resourceCoordinator: {
    readonly balanced: boolean;
    readonly disposed: boolean;
  };
}

export interface WorkerProbeSettledMarkDetail {
  readonly workerLaunched: boolean;
  readonly workerResultPassed: boolean;
  readonly recoveryPassed: boolean;
  readonly workerResourcesReleased: boolean;
}

export interface StartupPerformanceMarks {
  markOnloadEntered(): void;
  markOnloadSettled(): void;
  markOnunloadEntered(): void;
  markDisposalSettled(detail: DisposalSettledMarkDetail): void;
  markWorkerProbeSettled(detail: WorkerProbeSettledMarkDetail): void;
}

export function markModuleEvaluated(
  host: PerformanceMarkHost = globalThis,
): void {
  const timeline = host.performance;
  if (timeline === undefined) return;
  clearMarks(timeline, LIFECYCLE_MARKS);
  mark(timeline, STARTUP_PERFORMANCE_MARKS.moduleEvaluated);
}

export function createStartupPerformanceMarks(
  host: PerformanceMarkHost = globalThis,
): StartupPerformanceMarks {
  const timeline = host.performance;
  if (timeline === undefined) return NOOP_MARKS;
  clearMarks(timeline, INSTANCE_MARKS);
  return Object.freeze({
    markOnloadEntered: (): void =>
      mark(timeline, STARTUP_PERFORMANCE_MARKS.onloadEntered),
    markOnloadSettled: (): void =>
      mark(timeline, STARTUP_PERFORMANCE_MARKS.onloadSettled),
    markOnunloadEntered: (): void =>
      mark(timeline, STARTUP_PERFORMANCE_MARKS.onunloadEntered),
    markDisposalSettled: (detail: DisposalSettledMarkDetail): void =>
      mark(timeline, STARTUP_PERFORMANCE_MARKS.disposalSettled, detail),
    markWorkerProbeSettled: (detail: WorkerProbeSettledMarkDetail): void =>
      mark(timeline, STARTUP_PERFORMANCE_MARKS.workerProbeSettled, detail),
  });
}

const NOOP_MARKS: StartupPerformanceMarks = Object.freeze({
  markOnloadEntered: (): void => undefined,
  markOnloadSettled: (): void => undefined,
  markOnunloadEntered: (): void => undefined,
  markDisposalSettled: (): void => undefined,
  markWorkerProbeSettled: (): void => undefined,
});

function clearMarks(
  timeline: Pick<Performance, "clearMarks">,
  names: readonly string[],
): void {
  for (const name of names) {
    try {
      timeline.clearMarks(name);
    } catch {
      return;
    }
  }
}

function mark(
  timeline: Pick<Performance, "clearMarks" | "mark">,
  name: string,
  detail?: unknown,
): void {
  try {
    timeline.clearMarks(name);
    if (detail === undefined) {
      timeline.mark(name);
    } else {
      timeline.mark(name, { detail });
    }
  } catch {
    return;
  }
}
