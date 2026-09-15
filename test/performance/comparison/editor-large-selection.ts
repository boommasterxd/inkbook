import {
  maximumViewportStroke,
  scaleSessionOptions,
  verifyEndpointFanout,
  prepareEndpointFanout,
} from "../editor/large-selection-fixture";
import { expect } from "vitest";

import type { InkElementV1 } from "../../../src/domain/schema/public";
import type { ElementStore } from "../../../src/domain/store/public";
import type { SelectionHandleSession } from "../../../src/editor/selection/handle-session";
import { indexedStroke } from "../../fixtures/editor/stroke";
import { rectangle } from "../../unit/domain/schema/fixtures";
import type { ComparisonImplementation, ComparisonKernel, ComparisonScenario } from "./contracts";
import { DomainComparisonScheduler } from "./domain-scheduler";
import { maximumEndpointFixture, passThroughPlanner } from "./editor-large-fixtures";

const file = "test/performance/editor/selection-hot-paths.test.ts";
const sessionModule = "editor/selection/handle-session";
const storeModule = "domain/store/public";
const scaleTest = "keeps a tight 10,000-stroke scale frame off the linear pointer path";
const maximumTest =
  "routes 488 maximum strokes through the indexed hit path and bounded commit slices";
const endpointTest = "bounds preparation for a near-maximum 19,929-endpoint selection fan-out";

const LARGE_SELECTION_SCENARIOS: readonly ComparisonScenario[] = [
  ...(["setup", "preview"] as const).map((phase): ComparisonScenario => ({
    id: `editor.large-selection.scale.${phase}`,
    modules: [sessionModule, storeModule, "domain/geometry/public"],
    covers: [{ file, test: scaleTest, ordinals: [phase === "setup" ? 1 : 2] }],
    statistics: [
      {
        kind: phase === "setup" ? "max" : "p99",
        population: phase === "setup" ? "operations" : "samples",
        minimumSamples: phase === "setup" ? 1 : 100,
      },
    ],
    execution: "sync",

    warmupOperations: 1,
    create: (implementation) => scaleKernel(implementation, phase),
  })),
  ...(["decision", "hit", "slices"] as const).map((phase): ComparisonScenario => ({
    id: `editor.large-selection.maximum-strokes.${phase}`,
    modules: [sessionModule, storeModule, "obsidian/embeds/active-editor/scene-store"],
    covers: [
      {
        file,
        test: maximumTest,
        ordinals: phase === "decision" ? [1] : phase === "hit" ? [2] : [3, 4],
      },
    ],
    ...selectionPhaseMeasurement(phase === "slices"),

    warmupOperations: phase === "slices" ? 1 : 20,
    create: (implementation) => maximumKernel(implementation, phase),
  })),
  ...(["preview", "slices"] as const).map((phase): ComparisonScenario => ({
    id: `editor.large-selection.endpoint-fanout.${phase}`,
    modules: [sessionModule, storeModule],
    covers: [{ file, test: endpointTest, ordinals: phase === "preview" ? [1] : [2, 3] }],
    ...selectionPhaseMeasurement(phase === "slices"),

    warmupOperations: 1,
    create: (implementation) => endpointKernel(implementation, phase),
  })),
];

function selectionPhaseMeasurement(
  sliced: boolean,
): Pick<ComparisonScenario, "statistics" | "execution"> {
  return sliced
    ? {
        statistics: [
          { kind: "p95", population: "samples" },
          { kind: "max", population: "samples" },
        ],
        execution: "async",
      }
    : {
        statistics: [{ kind: "p99", population: "samples", minimumSamples: 100 }],
        execution: "sync",
      };
}

function scaleKernel(
  implementation: ComparisonImplementation,
  phase: "setup" | "preview",
): ComparisonKernel {
  const { Session, Store } = selectionImplementation(implementation);
  const { calculateElementBounds } =
    implementation.get<typeof import("../../../src/domain/geometry/public")>(
      "domain/geometry/public",
    );
  const elements = [
    ...Array.from({ length: 10_000 }, (_, index) => indexedStroke(index)),
    ...Array.from({ length: 256 }, (_, index) => ({ ...rectangle(20_001 + index), rotation: 37 })),
  ];
  const bounds = elements.map(calculateElementBounds);
  const minX = Math.min(...bounds.map((value) => value.minX));
  const minY = Math.min(...bounds.map((value) => value.minY));
  const maxX = Math.max(...bounds.map((value) => value.maxX));
  const maxY = Math.max(...bounds.map((value) => value.maxY));
  const store = new Store(elements);
  const createSession = () =>
    new Session(scaleSessionOptions(elements, store, { minX, minY, maxX, maxY }));
  let session: SelectionHandleSession;
  const samples: number[] = [];
  return {
    reset() {
      if (phase === "preview") session = createSession();
      samples.length = 0;
    },
    run() {
      if (phase === "setup") return createSession();
      for (let frame = 0; frame < 120; frame += 1) {
        const started = performance.now();
        session.update({ x: maxX + frame + 1, y: maxY + (frame + 1) / 2 });
        samples.push(performance.now() - started);
      }
      return session;
    },
    verify(result) {
      expect(result).toBeInstanceOf(Session);
      if (phase === "setup") return;
      const points = session.preview.previewFrame?.points;
      expect(points?.[0]?.x).toBeCloseTo(minX, 3);
      expect(points?.[0]?.y).toBeCloseTo(minY, 3);
      expect(points?.[2]?.x).toBeCloseTo(maxX + 120, 3);
      expect(points?.[2]?.y).toBeCloseTo(maxY + 60, 3);
    },
    ...(phase === "preview" ? { measurementSamples: () => samples } : {}),
    dispose() {},
  };
}

function maximumKernel(
  implementation: ComparisonImplementation,
  phase: "decision" | "hit" | "slices",
): ComparisonKernel {
  const { SelectionHandleSession: Session } =
    implementation.get<typeof import("../../../src/editor/selection/handle-session")>(
      sessionModule,
    );
  const strokes = Array.from({ length: 488 }, (_, index) => maximumViewportStroke(index));
  if (phase === "hit") return indexedMissKernel(implementation, strokes);
  let session: SelectionHandleSession;
  const scheduler = new DomainComparisonScheduler(1);
  return {
    reset() {
      session = new Session({
        action: { kind: "move" },
        elements: strokes,
        planner: passThroughPlanner,
        startPointer: { x: 0, y: 0 },
      });
      session.update({ x: 2, y: 3 });
    },
    run:
      phase === "decision"
        ? () => session.prepareCommit()
        : async () => {
            scheduler.start();
            const prepared = await session.prepareCommitTimeSliced(scheduler);
            scheduler.finish();
            return prepared;
          },
    verify(result) {
      if (phase === "decision") {
        expect(result).toEqual({ status: "time-sliced-required" });
        return;
      }
      const prepared = result as Awaited<
        ReturnType<SelectionHandleSession["prepareCommitTimeSliced"]>
      >;
      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready") throw new Error("Expected prepared strokes.");
      expect(prepared.replacements).toHaveLength(488);
      const first = prepared.replacements[0];
      const last = prepared.replacements[prepared.replacements.length - 1];
      if (first?.kind !== "stroke" || last?.kind !== "stroke") throw new Error("Expected strokes.");
      expect(first.points.slice(0, 3)).toEqual(new Float64Array([4, 103, 0.5]));
      expect(last.points.slice(-3)).toEqual(new Float64Array([11, 103.487, 0.5]));
    },
    ...(phase === "slices" ? { measurementSamples: () => scheduler.samples } : {}),
    dispose() {},
  };
}

function indexedMissKernel(
  implementation: ComparisonImplementation,
  strokes: readonly InkElementV1[],
): ComparisonKernel {
  const { ElementStore: Store } =
    implementation.get<typeof import("../../../src/domain/store/public")>(storeModule);
  const { ElementSceneStore: Scene } = implementation.get<
    typeof import("../../../src/obsidian/embeds/active-editor/scene-store")
  >("obsidian/embeds/active-editor/scene-store");
  const store = new Store(
    strokes.map((stroke) =>
      stroke.kind === "stroke" ? { ...stroke, points: Array.from(stroke.points) } : stroke,
    ),
  );
  const scene = new Scene(store);
  return {
    run: () => scene.hit({ x: 2_048, y: 50 }, "mouse", 1),
    verify(result) {
      expect(result).toBeNull();
    },
    dispose() {
      scene.release();
    },
  };
}

function endpointKernel(
  implementation: ComparisonImplementation,
  phase: "preview" | "slices",
): ComparisonKernel {
  const { Session, Store } = selectionImplementation(implementation);
  const { elements, targetIds } = maximumEndpointFixture();
  let store: ElementStore;
  let session: SelectionHandleSession;
  const scheduler = new DomainComparisonScheduler(Math.ceil(2 / 0.05));
  const makeSession = () =>
    new Session({
      action: { kind: "move" },
      elements: targetIds.map((id) => store.get(id)!.element as InkElementV1),
      planner: store,
      startPointer: { x: 0, y: 0 },
    });
  return {
    async reset() {
      store = new Store(elements);
      const warm = makeSession();
      warm.update({ x: 1, y: 1 });
      await commitEndpoints(store, warm, new DomainComparisonScheduler(40));
      store.resetInstrumentation();
      session = makeSession();
      if (phase === "slices") session.update({ x: 2, y: 3 });
    },
    run:
      phase === "preview"
        ? () => session.update({ x: 2, y: 3 })
        : () => commitEndpoints(store, session, scheduler),
    verify(result) {
      if (phase === "preview") {
        expect(result).toMatchObject({ exactElements: [], exactPreviewTruncated: true });
        expect(session.prepareCommit()).toEqual({ status: "time-sliced-required" });
        return;
      }
      expect(result).toMatchObject({ status: "committed" });
      const commit = result as ReturnType<ElementStore["commitPreparedElementReplacement"]>;
      expect(commit.delta?.changes).toHaveLength(19_968);
      verifyEndpointFanout(store, elements[39]!.id);
    },
    ...(phase === "slices" ? { measurementSamples: () => scheduler.samples } : {}),
    dispose() {},
  };
}

async function commitEndpoints(
  store: ElementStore,
  session: SelectionHandleSession,
  scheduler: DomainComparisonScheduler,
) {
  scheduler.start();
  const prepared = await prepareEndpointFanout(store, session, scheduler);
  scheduler.finish();
  if (prepared.token === null) throw new Error("Expected prepared replacement token.");
  const commit = store.commitPreparedElementReplacement(prepared.token);
  if (commit.status !== "committed") throw new Error("Expected committed replacement.");
  return commit;
}

export { LARGE_SELECTION_SCENARIOS as largeSelectionScenarios };

function selectionImplementation(implementation: ComparisonImplementation) {
  return {
    Session:
      implementation.get<typeof import("../../../src/editor/selection/handle-session")>(
        sessionModule,
      ).SelectionHandleSession,
    Store:
      implementation.get<typeof import("../../../src/domain/store/public")>(storeModule)
        .ElementStore,
  };
}
