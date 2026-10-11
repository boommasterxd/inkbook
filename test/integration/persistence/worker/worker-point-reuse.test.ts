import { expect, it, vi } from "vitest";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/document-runtime";
import { attachDocumentWorkerHost } from "../../../../src/persistence/worker/runtime/worker-host";
import { WorkerDocumentRuntimePort } from "../../../../src/persistence/worker/runtime/worker-bridge";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { TestWorkerEndpoint } from "../../../fixtures/persistence/worker-endpoint";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../fixtures/persistence/worker-snapshot";
import type { DocumentRuntimeRequest } from "../../../../src/persistence/worker/runtime/types";

it("retains worker-owned shape points through hosted move and undo requests", async () => {
  const clientEndpoint = new TestWorkerEndpoint();
  const hostEndpoint = new TestWorkerEndpoint();
  clientEndpoint.peer = hostEndpoint;
  hostEndpoint.peer = clientEndpoint;
  clientEndpoint.cloneTransfers = true;
  hostEndpoint.cloneTransfers = true;
  const identity = {
    sessionId: "point-reuse",
    workerEpoch: 1,
    operationId: 1,
    purpose: "background" as const,
  };
  const runtime = new DocumentWorkerRuntime(identity, null, undefined, true);
  const fallback = new DocumentWorkerRuntime(identity);
  const decodedRequests = observeDecodedRequests(runtime);
  const detach = attachDocumentWorkerHost(hostEndpoint, runtime);
  const client = new WorkerDocumentRuntimePort(() => clientEndpoint, {
    workScheduler: new TestWorkScheduler(),
    frameIntervalMilliseconds: () => 1_000 / 60,
  });
  const stroke = createTestStroke();
  Object.freeze(stroke.points);
  try {
    expect(
      await client.execute({
        baseModelRevision: null,
        identity,
        modelRevision: 0,
        snapshot: { ...createWorkerSnapshot([stroke]), revision: 0 },
        type: "model-sync-full",
      }),
    ).toMatchObject({ type: "model-sync-success" });
    expect(await fallback.execute(decodedRequests[0]!)).toMatchObject({
      type: "model-sync-success",
    });
    const original = requestStroke(decodedRequests[0]!);
    for (const [index, offset] of [
      { x: 5, y: 7 },
      { x: 0, y: 0 },
    ].entries()) {
      const transferredBefore = clientEndpoint.transfers.flat().length;
      expect(
        await client.execute({
          baseModelRevision: index,
          identity,
          modelRevision: index + 1,
          changedElements: [
            {
              ...stroke,
              offset,
              pivot: { x: stroke.pivot.x + offset.x, y: stroke.pivot.y + offset.y },
            },
          ],
          type: "model-sync-incremental",
        }),
      ).toMatchObject({ type: "model-sync-success" });
      expect(await fallback.execute(decodedRequests[index + 1]!)).toMatchObject({
        type: "model-sync-success",
      });
      expect(clientEndpoint.transfers.flat().length).toBe(transferredBefore);
      expect(requestStroke(decodedRequests[index + 1]!).points).toBe(original.points);
      for (const model of [runtime, fallback]) {
        expect(model.instrumentation).toMatchObject({
          fragmentBuilds: 0,
          sampleEncodingBuilds: 0,
          shapeBuilds: 0,
        });
      }
    }
    const request = {
      sessionId: identity.sessionId,
      workerEpoch: identity.workerEpoch,
      baseModelRevision: 2,
      modelRevision: 2,
      exportGeneration: 1,
      type: "export-incremental" as const,
    };
    const [nativeOutput, fallbackOutput] = await Promise.all([
      client.execute(request),
      fallback.execute(request),
    ]);
    expect(nativeOutput.type).toBe("export-success");
    if (nativeOutput.type !== "export-success" || fallbackOutput.type !== "export-success")
      throw new Error("Expected exports.");
    const outputBytes = (output: string | Uint8Array) =>
      typeof output === "string" ? new TextEncoder().encode(output) : output;
    expect({ ...nativeOutput, output: outputBytes(nativeOutput.output) }).toEqual({
      ...fallbackOutput,
      output: outputBytes(fallbackOutput.output),
    });
  } finally {
    fallback.terminate();
    client.terminate();
    detach();
  }
});

function observeDecodedRequests(runtime: DocumentWorkerRuntime) {
  const decodedRequests: DocumentRuntimeRequest[] = [];
  const execute = runtime.execute.bind(runtime);
  vi.spyOn(runtime, "execute").mockImplementation((header, observer, prepare) =>
    execute(header, observer, async (context) => {
      const request = prepare === undefined ? header : await prepare(context);
      decodedRequests.push(request);
      return request;
    }),
  );
  return decodedRequests;
}

function requestStroke(request: DocumentRuntimeRequest) {
  const element =
    request.type === "model-sync-full"
      ? request.snapshot.elements[0]
      : request.type === "model-sync-incremental"
        ? request.changedElements?.[0]
        : undefined;
  if (element?.kind !== "stroke") throw new Error("Expected stroke request.");
  return element;
}
