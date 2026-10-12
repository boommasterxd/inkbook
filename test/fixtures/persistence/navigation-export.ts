import type { InkSnapshotV1 } from "../../../src/domain/schema/public";
import { DocumentWorkerRuntime } from "../../../src/persistence/worker/runtime/document-runtime";
import { GestureAwareSliceScheduler } from "../../../src/persistence/worker/runtime/slice-scheduler";
import { createProductionDocumentRuntime } from "../../../src/persistence/worker/runtime/production-document-runtime";
import { attachDocumentWorkerHost } from "../../../src/persistence/worker/runtime/worker-host";
import { createWorkerBridgeClient, createWorkerBridgeEndpoints } from "./worker-bridge";
import { createTestStroke, createWorkerSnapshot } from "./worker-snapshot";
import { TestWorkScheduler } from "./work-scheduler";

export const executor = { sessionId: "session-a", workerEpoch: 1 };
export const identity = { ...executor, operationId: 1, purpose: "background" as const };
export const exportRequest = {
  ...executor,
  baseModelRevision: 0,
  exportGeneration: 1,
  modelRevision: 0,
  type: "export-incremental" as const,
};
export const document = createWorkerSnapshot(
  Array.from({ length: 3 }, (_, index) => {
    const stroke = createTestStroke();
    return {
      ...stroke,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      style: { ...stroke.style, pressureEnabled: false },
    };
  }),
);

export function createSuspendedExportFixture(bridge: boolean, snapshot: InkSnapshotV1 = document) {
  let release!: () => void;
  let markParked!: () => void;
  let blocked = true;
  let runtime!: DocumentWorkerRuntime;
  const parked = new Promise<void>((resolve) => {
    markParked = resolve;
  });
  const scheduler = new TestWorkScheduler({
    checkpoint: () => {
      if (!blocked || runtime.instrumentation.fragmentBuilds !== 1) return undefined;
      markParked();
      return new Promise<void>((resolve) => {
        release = () => {
          blocked = false;
          resolve();
        };
      });
    },
  });
  runtime = bridge
    ? createProductionDocumentRuntime(executor, { workScheduler: scheduler })
    : new DocumentWorkerRuntime(
        executor,
        new GestureAwareSliceScheduler({
          isInputActive: () => false,
          workScheduler: scheduler,
        }),
      );
  const endpoints = createWorkerBridgeEndpoints();
  const detach = attachDocumentWorkerHost(endpoints.hostEndpoint, runtime);
  const port = bridge ? createWorkerBridgeClient(endpoints.clientEndpoint) : runtime;
  return {
    detach,
    parked,
    port,
    release: () => release(),
    runtime,
    synchronize: () =>
      port.execute({
        baseModelRevision: null,
        identity,
        modelRevision: snapshot.revision,
        snapshot,
        type: "model-sync-full",
      }),
    export: () =>
      port.execute({
        ...exportRequest,
        baseModelRevision: snapshot.revision,
        modelRevision: snapshot.revision,
      }),
    prepare: (index: number, reserve: boolean) =>
      port.execute({
        basisRevision: snapshot.revision,
        identity: { ...identity, operationId: index + 2 },
        ids: [snapshot.elements[index]!.id],
        ...(reserve ? { speculative: true, navigationReserve: true } : {}),
        type: "prepare-scene-paths",
      }),
  };
}
