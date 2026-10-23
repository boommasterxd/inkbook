import { expect, it, vi } from "vitest";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/document-runtime";
import { attachDocumentWorkerHost } from "../../../../src/persistence/worker/runtime/bridge/worker-host";
import { WorkerDocumentRuntimePort } from "../../../../src/persistence/worker/runtime/bridge/worker-bridge";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { createWorkerBridgeEndpoints } from "../../../fixtures/persistence/worker-bridge";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../fixtures/persistence/worker-snapshot";
import type { DocumentRuntimeRequest } from "../../../../src/persistence/worker/runtime/types";
import * as sampleCodec from "../../../../src/persistence/serialization/metadata/stroke-sample-codec";

it("retains worker-owned shape points through hosted move, removal and restore requests", async () => {
  const { clientEndpoint, hostEndpoint } = createWorkerBridgeEndpoints();
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
  const encoding = vi.spyOn(sampleCodec, "encodeStrokeSamplesSteps");
  try {
    const initial: DocumentRuntimeRequest = {
      baseModelRevision: null,
      identity,
      modelRevision: 0,
      snapshot: { ...createWorkerSnapshot([stroke]), revision: 0 },
      type: "model-sync-full",
    };
    expect(await client.execute(initial)).toMatchObject({ type: "model-sync-success" });
    expect(await fallback.execute(initial)).toMatchObject({
      type: "model-sync-success",
    });
    await compareExports(client, fallback, identity, 0);
    expect(encoding).toHaveBeenCalledTimes(2);
    encoding.mockClear();
    const original = requestStroke(decodedRequests[0]!);
    for (const [index, offset] of [
      { x: 5, y: 7 },
      { x: 0, y: 0 },
      null,
      { x: 0, y: 0 },
      null,
      { x: 0, y: 0 },
    ].entries()) {
      const transferredBefore = clientEndpoint.transfers.flat().length;
      const request: DocumentRuntimeRequest = {
        baseModelRevision: index,
        identity,
        modelRevision: index + 1,
        ...(offset === null
          ? { removedIds: [stroke.id] }
          : {
              changedElements: [
                {
                  ...stroke,
                  offset,
                  pivot: { x: stroke.pivot.x + offset.x, y: stroke.pivot.y + offset.y },
                },
              ],
              ...(index >= 3 ? { orderChanges: { content: [stroke.id] } } : {}),
            }),
        type: "model-sync-incremental",
      };
      expect(await client.execute(request)).toMatchObject({ type: "model-sync-success" });
      expect(await fallback.execute(request)).toMatchObject({
        type: "model-sync-success",
      });
      expect(clientEndpoint.transfers.flat().length).toBe(transferredBefore);
      if (offset !== null)
        expect(
          requestStroke(
            decodedRequests.filter((entry) => entry.type.startsWith("model-sync"))[index + 1]!,
          ).points,
        ).toBe(original.points);
      for (const model of [runtime, fallback]) {
        expect(model.instrumentation).toMatchObject({
          fragmentBuilds: index >= 4 ? 2 : 1,
          sampleEncodingBuilds: 1,
          shapeBuilds: 1,
        });
      }
      if (index === 3 || index === 5) {
        await compareExports(client, fallback, identity, index + 1);
        expect(encoding).not.toHaveBeenCalled();
        for (const model of [runtime, fallback])
          expect(model.instrumentation.sampleEncodingHits).toBe(index === 3 ? 1 : 2);
      }
    }
  } finally {
    encoding.mockRestore();
    fallback.terminate();
    client.terminate();
    detach();
  }
});

async function compareExports(
  client: WorkerDocumentRuntimePort,
  fallback: DocumentWorkerRuntime,
  identity: { readonly sessionId: string; readonly workerEpoch: number },
  revision: number,
) {
  const request = {
    ...identity,
    baseModelRevision: revision,
    modelRevision: revision,
    exportGeneration: revision + 1,
    type: "export-incremental" as const,
  };
  const [nativeOutput, fallbackOutput] = await Promise.all([
    client.execute(request),
    fallback.execute(request),
  ]);
  if (nativeOutput.type !== "export-success" || fallbackOutput.type !== "export-success")
    throw new Error("Expected exports.");
  expect({ ...nativeOutput, output: outputBytes(nativeOutput.output) }).toEqual({
    ...fallbackOutput,
    output: outputBytes(fallbackOutput.output),
  });
}

function outputBytes(output: string | Uint8Array) {
  return typeof output === "string" ? new TextEncoder().encode(output) : output;
}

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
