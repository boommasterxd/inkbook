import { createFallbackDeadlineClock } from "../persistence/fallback-deadline-clock";
import { FallbackSliceProbe } from "../persistence/fallback-slice-probe";
import { createStandardPersistenceFixture } from "../persistence/fixtures";
import type { ComparisonImplementation, ComparisonKernel, ComparisonScenario } from "./contracts";
import { sliceSamples } from "./persistence-slices";

type RuntimeModule = typeof import("../../../src/persistence/worker/runtime/public");
type Serialization = typeof import("../../../src/persistence/serialization/public");
type RuntimeRequest =
  import("../../../src/persistence/worker/runtime/public").DocumentRuntimeRequest;
const phases = [
  "migration",
  "clipboard-encode",
  "clipboard-decode",
  "export",
  "preflight",
  "read-back",
] as const;
type Phase = (typeof phases)[number];

export const PERSISTENCE_FALLBACK_SCENARIOS: readonly ComparisonScenario[] = phases.map(
  (phase) => ({
    id: `persistence-fallback-${phase}-slices`,
    modules: ["persistence/worker/runtime/public", "persistence/serialization/public"],
    covers: [
      {
        file: "test/performance/persistence/worker-fallback.test.ts",
        test: "bounds validation, migration, clipboard, export, hashing, preflight, and read-back slices",
        ordinals: [1, 2],
      },
    ],
    execution: "async-sequence",
    sequenceLength: phases.length,
    measurementGroup: "persistence-fallback-phases",
    statistics: [
      { kind: "p95", population: "samples", minimumSamples: 100 },
      { kind: "max", population: "samples" },
    ],

    warmupOperations: 1,
    create: (implementation, refreshRate) => fallbackKernel(implementation, refreshRate),
  }),
);

async function fallbackKernel(
  implementation: ComparisonImplementation,
  refreshRate: number,
): Promise<ComparisonKernel> {
  const api = implementation.get<RuntimeModule>("persistence/worker/runtime/public");
  const serialization = implementation.get<Serialization>("persistence/serialization/public");
  const original = createStandardPersistenceFixture();
  const snapshot = { ...original, elements: original.elements.slice(10_000, 10_257) };
  const serialized = serialization.serializeInkbookDocument(snapshot);
  if (!serialized.ok) throw new Error(serialized.error.code);
  const migrated = serialized.value.svg
    .replace('data-inkbook-version="1"', 'data-inkbook-version="0"')
    .replace(/ data-inkbook-snapshot-sha256="[0-9a-f]{64}"/u, "")
    .replace('"version":1', '"version":0');
  const probe = new FallbackSliceProbe();
  const deadlineClock = createFallbackDeadlineClock();
  const scheduler = new api.GestureAwareSliceScheduler({
    now: () => deadlineClock(),
    sliceMilliseconds: (1000 / refreshRate) * 0.55,
    isInputActive: probe.isInputActive,
    yieldControl: probe.yieldControl,
  });
  const runtime = new api.DocumentWorkerRuntime(
    { sessionId: "comparison", workerEpoch: 2 },
    scheduler,
  );
  const context = {
    identity: { operationId: 1, sessionId: "comparison", workerEpoch: 2 },
    snapshot,
    migrated,
    output: serialized.value.svg as string | Uint8Array,
    customText: "",
  };
  return {
    async *run() {
      for (const phase of phases) {
        probe.startOperation(phase);
        const request = phaseRequest(phase, context);
        const result = await runtime.execute(request);
        probe.finishOperation();
        if (!result.type.endsWith("success") || ("result" in result && !result.result.ok))
          throw new Error(`Fallback ${phase} failed.`);
        if (result.type === "clipboard-encode-success" && result.result.ok)
          context.customText = result.result.value.customText;
        if (result.type === "export-success") context.output = result.output;
        yield;
      }
      return { samples: probe.durations };
    },
    measurementSamples(result, metricId) {
      if (!phases.some((phase) => metricId === `persistence-fallback-${phase}-slices`))
        throw new Error(`Unknown fallback metric: ${metricId}`);
      return sliceSamples(result);
    },
    verify(result) {
      if (sliceSamples(result).length < 100 || probe.operations.size !== phases.length)
        throw new Error("Fallback slice population is incomplete.");
      for (const measurement of probe.operations.values()) {
        if (measurement.syntheticInputSamples < 2 || measurement.inputPauseYields < 2)
          throw new Error("Fallback operation did not yield to active input.");
      }
    },
    dispose: () => runtime.terminate(),
  };
}

function phaseRequest(
  phase: Phase,
  context: {
    identity: { operationId: number; sessionId: string; workerEpoch: number };
    snapshot: ReturnType<typeof createStandardPersistenceFixture>;
    migrated: string;
    output: string | Uint8Array;
    customText: string;
  },
): RuntimeRequest {
  const { identity, snapshot } = context;
  if (phase === "migration")
    return {
      identity: { ...identity, purpose: "migration" },
      input: context.migrated,
      type: "unlock",
    };
  const encodeRequest = {
    basisRevision: snapshot.revision,
    identity: { ...identity, purpose: "clipboard" as const },
    selectedIds: snapshot.elements.slice(0, 100).map(({ id }) => id),
    type: "clipboard-encode" as const,
  };
  if (phase === "clipboard-encode") return encodeRequest;
  if (phase === "clipboard-decode")
    return {
      basisRevision: snapshot.revision,
      candidates: { customText: context.customText },
      identity: { ...identity, purpose: "clipboard", operationId: 2 },
      type: "clipboard-decode",
    };
  if (phase === "export")
    return {
      baseModelRevision: snapshot.revision,
      exportGeneration: 1,
      modelRevision: snapshot.revision,
      sessionId: identity.sessionId,
      type: "export-incremental",
      workerEpoch: identity.workerEpoch,
    };
  return {
    identity: { ...identity, purpose: phase },
    input: context.output,
    type: "verify-output",
  };
}
