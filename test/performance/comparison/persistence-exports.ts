import { createStandardPersistenceFixture, replaceFirstStroke } from "../persistence/fixtures";
import type { ComparisonImplementation, ComparisonKernel, ComparisonScenario } from "./contracts";

declare function setImmediate(callback: () => void): void;

type Serialization = typeof import("../../../src/persistence/serialization/public");
type Production =
  typeof import("../../../src/persistence/worker/runtime/production-document-runtime");
type Geometry = typeof import("../../../src/domain/geometry/public");
type Spatial = typeof import("../../../src/domain/spatial/index");
type Runtime = InstanceType<
  (typeof import("../../../src/persistence/worker/runtime/public"))["DocumentWorkerRuntime"]
>;
const modules = [
  "persistence/worker/runtime/production-document-runtime",
  "domain/geometry/public",
  "domain/spatial/index",
];
const file = "test/performance/persistence/serialization-and-worker.test.ts";

export const PERSISTENCE_EXPORT_SCENARIOS: readonly ComparisonScenario[] = [
  ...(["full", "incremental", "order"] as const).map((kind, index): ComparisonScenario => ({
    id: `persistence-export-${kind}`,
    modules,
    covers: [
      { file, test: "measures full and one-stroke incremental export", ordinals: [index + 1] },
    ],
    execution: "async",
    statistics: [{ kind: "p95", population: "operations" }],

    warmupOperations: 1,
    create: (implementation) => createExportKernel(implementation, kind),
  })),
  {
    id: "persistence-export-warm-cache",
    modules: ["persistence/serialization/public"],
    covers: [
      {
        file: "test/performance/persistence/runtime-export-cache.test.ts",
        test: "bounds warm UTF-8 encoding work",
        ordinals: [1],
      },
    ],
    execution: "async",
    statistics: [{ kind: "p95", population: "operations" }],

    warmupOperations: 1,
    async create(implementation) {
      const { IncrementalDocumentSerializer } = implementation.get<Serialization>(
        "persistence/serialization/public",
      );
      const serializer = new IncrementalDocumentSerializer();
      if (!serializer.resetRuntime(createStandardPersistenceFixture()).ok)
        throw new Error("Cache fixture reset failed.");
      const baseline = await serializer.serializeRuntimeChunked({});
      if (!baseline.ok) throw new Error(baseline.error.code);
      const built = serializer.instrumentation.fragmentBuilds;
      return {
        run: () => serializer.serializeRuntimeChunked({}),
        verify(value) {
          const result = value as Awaited<ReturnType<typeof serializer.serializeRuntimeChunked>>;
          if (
            !result.ok ||
            result.value.hash !== baseline.value.hash ||
            serializer.instrumentation.fragmentBuilds !== built ||
            serializer.instrumentation.cacheElements !== 11_000
          )
            throw new Error("Warm export did not reuse canonical cached fragments.");
        },
        dispose: () => serializer.clear(),
      };
    },
  },
];

async function createExportKernel(
  implementation: ComparisonImplementation,
  kind: "full" | "incremental" | "order",
): Promise<ComparisonKernel> {
  const { createProductionDocumentRuntime } = implementation.get<Production>(modules[0]!);
  const geometry = implementation.get<Geometry>(modules[1]!);
  const spatial = implementation.get<Spatial>(modules[2]!);
  const snapshot = createStandardPersistenceFixture();
  const runtime = createProductionDocumentRuntime(
    { sessionId: "comparison", workerEpoch: 1 },
    { yieldControl: async () => undefined },
  );
  let generation = 0;
  const fullRequest = () => ({
    baseModelRevision: null,
    exportGeneration: ++generation,
    modelRevision: snapshot.revision,
    sessionId: "comparison",
    snapshot,
    type: "export-full" as const,
    workerEpoch: 1,
  });
  const reversedOrder = snapshot.elements.map(({ id }) => id).reverse();
  const changed = replaceFirstStroke(snapshot, snapshot.revision + 1);
  const bounds = geometry.calculateElementBounds(changed);
  const membership = spatial.spatialCellMembershipCount(bounds);
  const spatialOverflow = membership > spatial.MAX_ELEMENT_CELLS;
  let modelRevision = snapshot.revision;
  let needsRestore = false;
  if (kind !== "full")
    await acknowledge(runtime, await runtime.execute(fullRequest()), snapshot.elements.length);
  return {
    async reset() {
      if (!needsRestore) return;
      const restored = await runtime.execute({
        baseModelRevision: modelRevision,
        modelRevision: modelRevision + 1,
        identity: {
          operationId: ++generation,
          purpose: "clipboard",
          sessionId: "comparison",
          workerEpoch: 1,
        },
        type: "model-sync-incremental",
        ...(kind === "order"
          ? { orderChanges: { content: snapshot.elements.map(({ id }) => id) } }
          : { changedElements: [snapshot.elements[0]!] }),
      });
      if (restored.type !== "model-sync-success")
        throw new Error("Export fixture restoration failed.");
      modelRevision += 1;
      needsRestore = false;
    },
    run() {
      if (kind === "full") return runtime.execute(fullRequest());
      const request = {
        baseModelRevision: modelRevision,
        modelRevision: ++modelRevision,
        sessionId: "comparison",
        type: "export-incremental" as const,
        workerEpoch: 1,
        exportGeneration: ++generation,
      };
      needsRestore = true;
      return runtime.execute(
        kind === "order"
          ? {
              ...request,
              orderChanges: { content: reversedOrder },
            }
          : {
              ...request,
              changedElements: [changed],
              changedElementDerivations: [
                {
                  bounds,
                  elementId: changed.id,
                  spatialMemberships: spatialOverflow ? 0 : membership,
                  spatialOverflow,
                },
              ],
            },
      );
    },
    verify: (result) =>
      acknowledge(
        runtime,
        result as Awaited<ReturnType<Runtime["execute"]>>,
        snapshot.elements.length,
      ),
    dispose: () => runtime.terminate(),
  };
}

async function acknowledge(
  runtime: Runtime,
  result: Awaited<ReturnType<Runtime["execute"]>>,
  count: number,
): Promise<void> {
  if (result.type !== "export-success") throw new Error(`Export comparison failed: ${result.type}`);
  runtime.acknowledgeExport(
    {
      exportGeneration: result.exportGeneration,
      modelRevision: result.modelRevision,
      sessionId: result.sessionId,
      workerEpoch: result.workerEpoch,
    },
    true,
  );
  runtime.requestPrewarm();
  for (let attempts = 0; runtime.instrumentation.prewarmedElements < count; attempts += 1) {
    if (attempts > 10_000) throw new Error("Export prewarming did not finish.");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (
    runtime.instrumentation.cacheElements !== count ||
    runtime.instrumentation.cacheBytes > 64 * 1024 * 1024
  )
    throw new Error("Export cache exceeded its contract.");
}
