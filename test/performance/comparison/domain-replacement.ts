import { assert } from "vitest";

import type { InkElementV1, StrokeElementV1 } from "../../../src/domain/schema/public";
import type { ElementStore } from "../../../src/domain/store/public";
import type { ActiveEditorHistory } from "../../../src/obsidian/embeds/active-editor/history";
import { createStandardDomainFixture } from "../domain/standard-domain-fixture";
import type { ComparisonImplementation, ComparisonKernel, ComparisonScenario } from "./contracts";
import { DomainComparisonScheduler } from "./domain-scheduler";

type Phase = "materialization" | "prepare-commit" | "atomic" | "slices";
type Family = "large" | "incremental";
const phases: readonly { family: Family; phase: Phase; ordinals: readonly number[] }[] = [
  { family: "large", phase: "materialization", ordinals: [1] },
  { family: "large", phase: "prepare-commit", ordinals: [2] },
  { family: "large", phase: "slices", ordinals: [3, 4] },
  { family: "incremental", phase: "atomic", ordinals: [1] },
  { family: "incremental", phase: "slices", ordinals: [2, 3] },
];

export const DOMAIN_REPLACEMENT_SCENARIOS: readonly ComparisonScenario[] = phases.map(
  ({ family, phase, ordinals }) => ({
    id: `domain-${family}-replacement-${phase}`,
    statistics:
      phase === "slices"
        ? [
            { kind: "p95", population: "samples" },
            { kind: "max", population: "samples" },
          ]
        : [
            {
              kind: "p95",
              population: "samples",
              minimumSamples: family === "large" ? 50 : 5,
            },
          ],
    modules: [
      "domain/store/public",
      "editor/selection/transforms",
      "obsidian/embeds/active-editor/history",
    ],
    covers: [
      {
        file: `test/performance/domain/${family === "large" ? "domain-performance" : "incremental-replacement-performance"}.test.ts`,
        test:
          family === "large"
            ? "time-slices and atomically commits 50 canonical 10,000-stroke transforms"
            : "prepares in bounded slices and atomically commits only changed records",
        ordinals,
      },
    ],
    execution: "async-sequence",
    measurementGroup: `domain-${family}-replacement`,
    sequenceLength: family === "large" ? 50 : 6,

    warmupOperations: 0,
    create: (implementation) => replacementKernel(implementation, family, phase),
  }),
);

function replacementKernel(
  implementation: ComparisonImplementation,
  family: Family,
  phase: Phase,
): ComparisonKernel {
  const store =
    implementation.get<typeof import("../../../src/domain/store/public")>("domain/store/public");
  const transforms = implementation.get<typeof import("../../../src/editor/selection/transforms")>(
    "editor/selection/transforms",
  );
  const history = implementation.get<
    typeof import("../../../src/obsidian/embeds/active-editor/history")
  >("obsidian/embeds/active-editor/history");
  return new ReplacementComparisonKernel({ store, transforms, history }, family, phase);
}

interface ReplacementModules {
  readonly store: typeof import("../../../src/domain/store/public");
  readonly transforms: typeof import("../../../src/editor/selection/transforms");
  readonly history: typeof import("../../../src/obsidian/embeds/active-editor/history");
}

class ReplacementComparisonKernel implements ComparisonKernel {
  private readonly fixture = createStandardDomainFixture();
  private readonly scheduler = new DomainComparisonScheduler(40);
  private store!: ElementStore;
  private history!: ActiveEditorHistory;
  private measured = replacementMeasurements();
  private committed = 0;
  private originalPoints: readonly number[] = [];

  constructor(
    private readonly modules: ReplacementModules,
    private readonly family: Family,
    private readonly phase: Phase,
  ) {}

  async reset(): Promise<void> {
    this.store = new this.modules.store.ElementStore(this.fixture.elements);
    this.history = new this.modules.history.ActiveEditorHistory(noopHistoryModel());
    this.measured = replacementMeasurements();
    this.committed = 0;
    this.originalPoints = Array.from(
      (this.store.get(this.fixture.strokeIds[0]!)!.element as StrokeElementV1).points,
    );
    if (this.family === "large") {
      for (let step = 0; step < 50; step += 1) await this.transformStep(step);
      this.measured = replacementMeasurements();
      this.committed = 0;
    }
    this.store.resetInstrumentation();
  }

  async *run(): AsyncGenerator<void> {
    const count = this.family === "large" ? 50 : 6;
    for (let step = 0; step < count; step += 1) {
      await this.transformStep(step);
      yield;
    }
  }

  private async transformStep(step: number): Promise<void> {
    const elements = this.fixture.strokeIds.map(
      (id) => this.store.get(id)!.element as StrokeElementV1,
    );
    const distance = step % 2 === 0 ? 0.001 : -0.001;
    this.scheduler.start();
    const materializationStarted = performance.now();
    const moved = await this.modules.transforms.moveSelectionTimeSliced(
      elements,
      { x: distance, y: distance },
      this.scheduler,
    );
    this.measured.materialization.push(performance.now() - materializationStarted);
    assert.ok(moved !== null && moved.every((element) => element.kind === "stroke"));
    const commitStarted = performance.now();
    const prepared = await this.store.prepareElementReplacement(moved, this.scheduler);
    if (this.family === "incremental") this.scheduler.finish();
    assert.ok(prepared.token !== null);
    const atomicStarted = performance.now();
    const result = this.store.commitPreparedElementReplacement(prepared.token);
    const atomicDuration = performance.now() - atomicStarted;
    if (step > 0) this.measured.atomic.push(atomicDuration);
    if (this.family === "large") {
      await this.scheduler.yieldControl();
      assert.equal(
        this.history.registerAppliedReplacement(elements, moved, {
          redo: () => this.commitState(moved),
          undo: () => this.commitState(elements),
        }),
        true,
      );
    }
    this.measured["prepare-commit"].push(performance.now() - commitStarted);
    if (this.family === "large") this.scheduler.finish();
    this.measured.slices.push(...this.scheduler.samples);
    assert.equal(result.status, "committed");
    assert.equal(result.delta?.changes.length, 10_000);
    this.committed += 1;
  }

  private async commitState(elements: readonly InkElementV1[]): Promise<boolean> {
    const scheduler = new DomainComparisonScheduler(40);
    scheduler.start();
    const prepared = await this.store.prepareElementReplacement(elements, scheduler);
    scheduler.finish();
    return (
      prepared.token !== null &&
      this.store.commitPreparedElementReplacement(prepared.token).status === "committed"
    );
  }

  measurementSamples(_result: unknown, metricId?: string): readonly number[] {
    const phase =
      metricId === undefined
        ? this.phase
        : phases.find((entry) => metricId === `domain-${this.family}-replacement-${entry.phase}`)
            ?.phase;
    assert.ok(phase !== undefined);
    return this.measured[phase];
  }

  verify(): void {
    const count = this.family === "large" ? 50 : 6;
    assert.equal(this.committed, count);
    assert.equal(this.store.instrumentation.fullStoreScans, 0);
    assert.equal(this.store.instrumentation.publishedDeltas, count);
    assert.equal(this.store.instrumentation.recordReplacements, count * 10_000);
    assert.equal(this.store.instrumentation.timeSlicedIndexVisits, count * 10_000);
    assert.deepEqual(
      Array.from((this.store.get(this.fixture.strokeIds[0]!)!.element as StrokeElementV1).points),
      this.originalPoints,
    );
    if (this.family === "large") {
      assert.ok(this.history.commandCount > 0);
      assert.ok(this.history.retainedPayloadBytes <= 64 * 1024 * 1024);
    }
    assert.ok(this.measured.slices.length >= count * 100);
    assert.equal(this.measured.materialization.length, count);
    assert.equal(this.measured["prepare-commit"].length, count);
    assert.equal(this.measured.atomic.length, count - 1);
  }

  dispose(): void {
    this.history?.dispose();
    this.measured = replacementMeasurements();
  }
}

function noopHistoryModel() {
  return {
    commitBandOrder() {},
    commitElements() {},
    commitPage() {},
    removeElements() {},
    replaceElements() {},
  };
}

function replacementMeasurements(): Record<Phase, number[]> {
  return { materialization: [], "prepare-commit": [], atomic: [], slices: [] };
}
