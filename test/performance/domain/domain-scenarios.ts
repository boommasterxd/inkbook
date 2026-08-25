import type { InkElementV1, StrokeElementV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import { moveSelectionTimeSliced } from "../../../src/editor/selection/transforms";
import { LiveStrokeBuilder } from "../../../src/editor/tools/public";
import {
  ActiveEditorHistory,
  type ActiveEditorHistoryModel,
} from "../../../src/obsidian/embeds/active-editor/history";

import { createMaximumStroke } from "./standard-domain-fixture";

declare const process: {
  memoryUsage: () => { heapUsed: number };
  threadCpuUsage: () => { system: number; user: number };
};
declare function setImmediate(callback: () => void): void;

export interface Distribution {
  readonly maximum: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number | null;
  readonly sampleCount: number;
}

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

export interface MaximumStrokeRun {
  readonly append: Distribution;
  readonly handoff: Distribution;
  readonly maximumFinalizedChunkSamples: number;
  readonly maximumTailSamples: number;
}

export class MeasuredSliceScheduler {
  public maxSliceDuration = 0;
  readonly #sliceDurations: number[] = [];
  #deadline: number;
  #sliceStarted = readThreadCpuMilliseconds();

  public constructor(
    private readonly budgetMilliseconds: number,
    private readonly onYield: () => void = () => undefined,
  ) {
    this.#deadline = performance.now() + budgetMilliseconds;
  }

  public shouldYield = (): boolean => performance.now() >= this.#deadline;

  public yieldControl = async (): Promise<void> => {
    this.#measureSlice();
    this.onYield();
    await yieldToHostTask();
    this.#sliceStarted = readThreadCpuMilliseconds();
    this.#deadline = performance.now() + this.budgetMilliseconds;
  };

  public finish(): void {
    this.#measureSlice();
  }

  public get sliceDurations(): readonly number[] {
    return this.#sliceDurations;
  }

  #measureSlice(): void {
    const duration = readThreadCpuMilliseconds() - this.#sliceStarted;
    this.#sliceDurations.push(duration);
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

export function percentile(values: readonly number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] as number;
}

function distribution(values: readonly number[]): Distribution {
  return {
    maximum: Math.max(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: values.length >= 100 ? percentile(values, 0.99) : null,
    sampleCount: values.length,
  };
}

export function worstDistribution(values: readonly Distribution[]): Distribution {
  const p99Values = values.flatMap(({ p99 }) => (p99 === null ? [] : [p99]));
  return {
    maximum: Math.max(...values.map(({ maximum }) => maximum)),
    p50: Math.max(...values.map(({ p50 }) => p50)),
    p95: Math.max(...values.map(({ p95 }) => p95)),
    p99: p99Values.length === values.length ? Math.max(...p99Values) : null,
    sampleCount: values[0]?.sampleCount ?? 0,
  };
}

export function measureMaximumStrokeRun(strokeCount: number): MaximumStrokeRun {
  const source = createMaximumStroke();
  const appendDurations: number[] = [];
  const handoffDurations: number[] = [];
  let maximumTailSamples = 0;
  let maximumFinalizedChunkSamples = 0;
  for (let strokeIndex = 0; strokeIndex < strokeCount; strokeIndex += 1) {
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: source.style,
    });
    appendMaximumStroke(builder, source, appendDurations);
    const handoffStarted = performance.now();
    const commit = builder.finish();
    handoffDurations.push(performance.now() - handoffStarted);
    maximumTailSamples = Math.max(maximumTailSamples, commit.instrumentation.maximumTailSamples);
    maximumFinalizedChunkSamples = Math.max(
      maximumFinalizedChunkSamples,
      commit.instrumentation.maximumFinalizedChunkSamples,
    );
    if (commit.points.length !== 4096 * 3 || commit.geometry.d.length <= 100_000) {
      throw new Error("Maximum-stroke benchmark produced an incomplete handoff.");
    }
  }
  return {
    append: distribution(appendDurations),
    handoff: distribution(handoffDurations),
    maximumFinalizedChunkSamples,
    maximumTailSamples,
  };
}

function appendMaximumStroke(
  builder: LiveStrokeBuilder,
  source: StrokeElementV1,
  durations: number[],
): void {
  for (let point = 0; point < source.points.length; point += 3) {
    const started = performance.now();
    builder.append({
      pressure: source.points[point + 2] as number,
      time: point / 3,
      x: source.points[point] as number,
      y: source.points[point + 1] as number,
    });
    durations.push(performance.now() - started);
  }
}
