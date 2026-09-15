import { assert } from "vitest";

import type { ElementMutation, ElementStore } from "../../../src/domain/store/public";
import { createStandardDomainFixture } from "../domain/standard-domain-fixture";
import type { ComparisonImplementation, ComparisonKernel, ComparisonScenario } from "./contracts";
import { DomainComparisonScheduler } from "./domain-scheduler";

type Phase = "cut" | "restore" | "commit" | "slices";
const ordinals = { cut: [1], restore: [2], commit: [3], slices: [4, 5] };
const phases = ["cut", "restore", "commit", "slices"] as const;

export const DOMAIN_MUTATION_SCENARIOS: readonly ComparisonScenario[] = phases.map((phase) => ({
  id: `domain-clipboard-${phase}`,
  statistics:
    phase === "slices"
      ? [
          { kind: "p95", population: "samples" },
          { kind: "max", population: "samples" },
        ]
      : [
          {
            kind: "max",
            population: "samples",
            minimumSamples: phase === "commit" ? 10 : 5,
          },
        ],
  modules: ["domain/store/public"],
  covers: [
    {
      file: "test/performance/domain/element-mutation-performance.test.ts",
      test: "keeps atomic clipboard-scale store adoption",
      ordinals: ordinals[phase],
    },
  ],
  execution: "async-sequence",
  measurementGroup: "domain-clipboard-mutation",
  sequenceLength: 5,

  warmupOperations: 0,
  create: (implementation, refreshRate) => mutationKernel(implementation, refreshRate, phase),
}));

function mutationKernel(
  implementation: ComparisonImplementation,
  refreshRate: number,
  phase: Phase,
): ComparisonKernel {
  const { ElementStore } =
    implementation.get<typeof import("../../../src/domain/store/public")>("domain/store/public");
  return new MutationComparisonKernel(ElementStore, refreshRate, phase);
}

class MutationComparisonKernel implements ComparisonKernel {
  private readonly fixture = createStandardDomainFixture();
  private readonly scheduler: DomainComparisonScheduler;
  private store!: ElementStore;
  private mutation!: ElementMutation;
  private measured = mutationMeasurements();

  constructor(
    private readonly Store: typeof ElementStore,
    refreshRate: number,
    private readonly phase: Phase,
  ) {
    this.scheduler = new DomainComparisonScheduler(Math.ceil(550 / refreshRate / 0.05));
  }

  async reset(): Promise<void> {
    this.store = new this.Store(this.fixture.elements);
    const removed = new Set(this.fixture.strokeIds);
    this.mutation = {
      removeIds: this.fixture.strokeIds,
      bands: {
        content: this.store.materializeBandOrder("content").filter((id) => !removed.has(id)),
        highlight: this.store.materializeBandOrder("highlight").filter((id) => !removed.has(id)),
      },
    };
    await this.apply(await this.apply(this.mutation, "cut"), "restore");
    this.store.resetInstrumentation();
    this.measured = mutationMeasurements();
  }

  async *run(): AsyncGenerator<void> {
    for (let pair = 0; pair < 5; pair += 1) {
      const reverse = await this.apply(this.mutation, "cut");
      await this.apply(reverse, "restore");
      yield;
    }
  }

  private async apply(change: ElementMutation, phase: "cut" | "restore"): Promise<ElementMutation> {
    this.scheduler.start();
    const preparationStarted = performance.now();
    const prepared = await this.store.prepareElementMutation(change, this.scheduler);
    this.measured[phase].push(performance.now() - preparationStarted);
    assert.ok(prepared.status === "prepared" && prepared.token !== null);
    const commitStarted = performance.now();
    const committed = this.store.commitPreparedElementMutation(prepared.token);
    this.measured.commit.push(performance.now() - commitStarted);
    this.scheduler.finish();
    this.measured.slices.push(...this.scheduler.samples);
    assert.ok(committed.status === "committed" && committed.transition !== null);
    assert.equal(this.store.size, phase === "cut" ? 1_000 : 11_000);
    return committed.transition.reverse;
  }

  measurementSamples(_result: unknown, metricId?: string): readonly number[] {
    const phase =
      metricId === undefined
        ? this.phase
        : phases.find((entry) => metricId === `domain-clipboard-${entry}`);
    assert.ok(phase !== undefined);
    return this.measured[phase];
  }

  verify(): void {
    assert.equal(this.store.size, 11_000);
    assert.equal(this.store.instrumentation.fullStoreScans, 0);
    assert.equal(this.measured.cut.length, 5);
    assert.equal(this.measured.restore.length, 5);
    assert.equal(this.measured.commit.length, 10);
    assert.ok(this.measured.slices.length >= 500);
  }

  dispose(): void {
    this.measured = mutationMeasurements();
  }
}

function mutationMeasurements(): Record<Phase, number[]> {
  return { cut: [], restore: [], commit: [], slices: [] };
}
