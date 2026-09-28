import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import { DocumentWorkerRuntime } from "../../../src/persistence/worker/runtime/public";
import { attachDocumentWorkerHost } from "../../../src/persistence/worker/runtime/worker-host";
import { WorkerDocumentRuntimePort } from "../../../src/persistence/worker/runtime/worker-bridge";
import { TestWorkScheduler } from "./work-scheduler";
import { TestWorkerEndpoint } from "./worker-endpoint";
import { createTestStroke, createWorkerSnapshot } from "./worker-snapshot";

export function createWorkerBridgeHarness() {
  const { clientEndpoint, hostEndpoint } = createWorkerBridgeEndpoints();
  const runtime = new DocumentWorkerRuntime({ sessionId: "session-a", workerEpoch: 1 });
  const detach = attachDocumentWorkerHost(hostEndpoint, runtime);
  return { clientEndpoint, detach, hostEndpoint, runtime };
}

export function createWorkerBridgeEndpoints() {
  const clientEndpoint = new TestWorkerEndpoint();
  const hostEndpoint = new TestWorkerEndpoint();
  clientEndpoint.peer = hostEndpoint;
  hostEndpoint.peer = clientEndpoint;
  return { clientEndpoint, hostEndpoint };
}

export function createWorkerBridgeClient(endpoint: TestWorkerEndpoint) {
  return new WorkerDocumentRuntimePort(() => endpoint, {
    workScheduler: new TestWorkScheduler(),
    frameIntervalMilliseconds: () => 1_000 / 60,
  });
}

export function createOneStrokeWorkerSnapshot() {
  return createWorkerSnapshot([createTestStroke()]);
}

export function createWorkerUnlockRequest(input: Uint8Array) {
  return {
    identity: {
      operationId: 1,
      purpose: "unlock" as const,
      sessionId: "session-a",
      workerEpoch: 1,
    },
    input,
    type: "unlock" as const,
  };
}

export function serializeOneStrokeWorkerSnapshot() {
  const serialized = serializeInkbookDocument(createOneStrokeWorkerSnapshot());
  if (!serialized.ok) throw new Error(serialized.error.message);
  return serialized.value;
}
