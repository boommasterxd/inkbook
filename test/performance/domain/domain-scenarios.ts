import { distribution, type Distribution } from "./action-distribution";
import type { InkElementV1, StrokeElementV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import { moveSelectionTimeSliced } from "../../../src/editor/selection/transforms";
import {
  ActiveEditorHistory,
  type ActiveEditorHistoryModel,
} from "../../../src/obsidian/embeds/active-editor/history";

import { performanceMode } from "../timing-budget";

// Virtual cost per observed checkpoint, not a physical-device speed estimate.
export const CHECKPOINT_COST_MILLISECONDS = 0.05;

declare const process: {
  memoryUsage: () => { heapUsed: number };
  threadCpuUsage: () => { system: number; user: number };
};
declare function setImmediate(callback: () => void): void;

export interface TransformRun {
  readonly atomicCommit: Distribution;
  readonly commit: Distribution;
  readonly historyRegistration: Distribution;
  readonly materialization: Distribution;
  readonly maximumHeapGrowthBytes: number;
  readonly maximumRetainedHistoryBytes: number;
  readonly maximumSlice: number;
  readonly slices: Distribution;
}

export class MeasuredSliceScheduler {
  public maxSliceDuration = 0;
  readonly #sliceDurations: number[] = [];
  readonly #controlled = performanceMode() === "contracts";
  readonly #checkpointCounts: number[] = [];
  #checkpoints = 0;
  #state: "active" | "yielding" | "finished" = "active";
  #deadline: number;
  #sliceStarted = readThreadCpuMilliseconds();

  public constructor(
    private readonly budgetMilliseconds: number,
    private readonly onYield: () => void = () => undefined,
  ) {
    if (!Number.isFinite(budgetMilliseconds) || budgetMilliseconds <= 0) {
      throw new RangeError("Slice budgets must be finite and positive.");
    }
    this.#deadline = performance.now() + budgetMilliseconds;
  }

  public shouldYield = (): boolean => {
    this.#requireActive();
    this.#checkpoints += 1;
    return this.#controlled
      ? this.#checkpoints >= Math.ceil(this.budgetMilliseconds / CHECKPOINT_COST_MILLISECONDS)
      : performance.now() >= this.#deadline;
  };

  public yieldControl = async (): Promise<void> => {
    this.#requireActive();
    this.#measureSlice();
    this.#state = "yielding";
    try {
      this.onYield();
      await yieldToHostTask();
    } finally {
      this.#sliceStarted = readThreadCpuMilliseconds();
      this.#deadline = performance.now() + this.budgetMilliseconds;
      this.#state = "active";
    }
  };

  public finish(): void {
    if (this.#state === "finished") return;
    this.#requireActive();
    this.#measureSlice();
    this.#state = "finished";
  }

  public get checkpointCounts(): readonly number[] {
    return this.#checkpointCounts;
  }

  #requireActive(): void {
    if (this.#state !== "active") throw new Error(`Slice scheduler is ${this.#state}.`);
  }

  public get sliceDurations(): readonly number[] {
    return this.#sliceDurations;
  }

  #measureSlice(): void {
    const duration = readThreadCpuMilliseconds() - this.#sliceStarted;
    this.#sliceDurations.push(duration);
    this.#checkpointCounts.push(this.#checkpoints);
    this.#checkpoints = 0;
    this.maxSliceDuration = Math.max(this.maxSliceDuration, duration);
  }
}

export async function measureTransformRun(
  store: ElementStore,
  history: ActiveEditorHistory,
  strokeIds: readonly string[],
  operationCount: number,
  onYield?: (stableId: string, stableRecord: ReturnType<ElementStore["get"]>) => void,
): Promise<TransformRun> {
  const materializationDurations: number[] = [];
  const commitDurations: number[] = [];
  const atomicCommitDurations: number[] = [];
  const historyRegistrationDurations: number[] = [];
  const baselineHeapBytes = readHeapBytes();
  let maximumHeapBytes = baselineHeapBytes;
  let maximumRetainedHistoryBytes = history.retainedPayloadBytes;
  let maximumSlice = 0;
  const sliceDurations: number[] = [];
  for (let operation = 0; operation < operationCount; operation += 1) {
    {
      const elements = strokeIds.map((id) => requireStroke(store, id));
      const stableId = strokeIds[0] as string;
      const stableRecord = store.get(stableId);
      let committed = false;
      const scheduler = new MeasuredSliceScheduler(2, () => {
        if (!committed) onYield?.(stableId, stableRecord);
      });
      const distance = operation % 2 === 0 ? 0.001 : -0.001;
      const materializationStarted = performance.now();
      const moved = await moveSelectionTimeSliced(
        elements,
        { x: distance, y: distance },
        scheduler,
      );
      materializationDurations.push(performance.now() - materializationStarted);
      if (moved === null || !moved.every(isStroke)) {
        throw new Error("Transform benchmark unexpectedly cancelled or changed element kinds.");
      }
      const commitStarted = performance.now();
      const prepared = await store.prepareElementReplacement(moved, scheduler);
      if (prepared.status !== "prepared" || prepared.token === null) {
        throw new Error("Transform benchmark failed to prepare its atomic replacement.");
      }
      const atomicCommitStarted = performance.now();
      const result = store.commitPreparedElementReplacement(prepared.token);
      atomicCommitDurations.push(performance.now() - atomicCommitStarted);
      committed = true;
      await scheduler.yieldControl();
      const historyRegistrationStarted = performance.now();
      if (
        !history.registerAppliedReplacement(elements, moved, {
          redo: () => commitStrokeState(store, moved),
          undo: () => commitStrokeState(store, elements),
        })
      ) {
        throw new Error("Transform benchmark failed to retain its history command.");
      }
      historyRegistrationDurations.push(performance.now() - historyRegistrationStarted);
      commitDurations.push(performance.now() - commitStarted);
      scheduler.finish();
      sliceDurations.push(...scheduler.sliceDurations);
      maximumSlice = Math.max(maximumSlice, scheduler.maxSliceDuration);
      maximumRetainedHistoryBytes = Math.max(
        maximumRetainedHistoryBytes,
        history.retainedPayloadBytes,
      );
      if (result.status !== "committed" || result.delta?.changes.length !== 10_000) {
        throw new Error("Transform benchmark did not publish one complete atomic delta.");
      }
    }
    maximumHeapBytes = Math.max(maximumHeapBytes, readHeapBytes());
    await yieldToHostTask();
  }
  return {
    atomicCommit: distribution(atomicCommitDurations),
    commit: distribution(commitDurations),
    historyRegistration: distribution(historyRegistrationDurations),
    materialization: distribution(materializationDurations),
    maximumHeapGrowthBytes: Math.max(0, maximumHeapBytes - baselineHeapBytes),
    maximumRetainedHistoryBytes,
    maximumSlice,
    slices: distribution(sliceDurations),
  };
}

async function commitStrokeState(
  store: ElementStore,
  elements: readonly StrokeElementV1[],
): Promise<boolean> {
  const prepared = await store.prepareElementReplacement(elements, new MeasuredSliceScheduler(2));
  return (
    prepared.token !== null &&
    store.commitPreparedElementReplacement(prepared.token).status === "committed"
  );
}

export function createNoopHistoryModel(): ActiveEditorHistoryModel {
  return {
    commitBandOrder: () => undefined,
    commitElements: () => undefined,
    commitPage: () => undefined,
    removeElements: () => undefined,
    replaceElements: () => undefined,
  };
}

export function requireStroke(store: ElementStore, id: string): StrokeElementV1 {
  const element = store.get(id)?.element;
  if (element?.kind !== "stroke") throw new Error(`Expected stroke fixture record: ${id}`);
  return element as unknown as StrokeElementV1;
}

function isStroke(element: InkElementV1): element is StrokeElementV1 {
  return element.kind === "stroke";
}

function readHeapBytes(): number {
  return process.memoryUsage().heapUsed;
}

function readThreadCpuMilliseconds(): number {
  const usage = process.threadCpuUsage();
  return (usage.system + usage.user) / 1_000;
}

function yieldToHostTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function transformMetricsAnnotation(
  distributions: Readonly<{
    atomicCommit: Distribution;
    commit: Distribution;
    historyRegistration: Distribution;
    materialization: Distribution;
    slices: Distribution;
  }>,
  maximumSlice: number,
  maximumHeapGrowthBytes: number,
  maximumRetainedHistoryBytes: number,
): string {
  const { atomicCommit, commit, historyRegistration, materialization, slices } = distributions;
  return (
    `10k transform: materialization p50=${materialization.p50.toFixed(3)} ms, ` +
    `p95=${materialization.p95.toFixed(3)} ms, ` +
    `max=${materialization.maximum.toFixed(3)} ms; commit p50=${commit.p50.toFixed(3)} ms, ` +
    `p95=${commit.p95.toFixed(3)} ms, ` +
    `max=${commit.maximum.toFixed(3)} ms; atomicCommit p95=${atomicCommit.p95.toFixed(3)} ms, ` +
    `max=${atomicCommit.maximum.toFixed(3)} ms; history p95=${historyRegistration.p95.toFixed(3)} ms, ` +
    `max=${historyRegistration.maximum.toFixed(3)} ms; slice p95=${slices.p95.toFixed(3)} ms, ` +
    `max=${maximumSlice.toFixed(3)} ms, ` +
    `maxHeapGrowth=${(maximumHeapGrowthBytes / 1024 / 1024).toFixed(1)} MiB, ` +
    `maxHistory=${(maximumRetainedHistoryBytes / 1024 / 1024).toFixed(1)} MiB, oldSpaceLimit=384 MiB`
  );
}
