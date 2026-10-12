import { expect, it } from "vitest";
import { SessionScenePaths } from "../../../../src/obsidian/embeds/session-scene-paths";
import { RemoteScenePaths } from "../../../../src/rendering/scene/remote-scene-paths";
import type { SceneElementRecord } from "../../../../src/rendering/scene/types";
import type { PreparedScenePathEntry } from "../../../../src/domain/geometry/prepared-scene-paths";
import {
  createWorkerBridgeClient,
  createWorkerBridgeHarness,
} from "../../../fixtures/persistence/worker-bridge";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../fixtures/persistence/worker-snapshot";

it.each([false, true])(
  "retains only current IDs after delayed baseline synchronization, bridge=%s",
  async (bridge) => {
    const harness = createWorkerBridgeHarness();
    const port = bridge ? createWorkerBridgeClient(harness.clientEndpoint) : harness.runtime;
    const identity = {
      sessionId: "session-a",
      workerEpoch: 1,
      operationId: 1,
      purpose: "background" as const,
    };
    const elements = [1, 2, 3].map((index) => ({
      ...createTestStroke(),
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    const records = elements.map((element, rank): SceneElementRecord => ({
      element,
      rank,
      id: element.id,
      geometryVersion: 0,
      paintVersion: 0,
      band: "content",
      bounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
    }));
    await port.execute({
      baseModelRevision: null,
      identity,
      modelRevision: 0,
      snapshot: createWorkerSnapshot(elements),
      type: "model-sync-full",
    });
    let release!: () => void;
    const baseline = new Promise<boolean>((resolve) => {
      release = () => resolve(true);
    });
    let delayed = false;
    const session = new SessionScenePaths({
      disposed: () => false,
      executor: () => port,
      revision: () => 0,
      sessionId: "session-a",
      workerEpoch: () => 1,
      synchronize: () => (delayed ? baseline : Promise.resolve(true)),
    });
    let settled: Promise<readonly PreparedScenePathEntry[] | undefined> | undefined;
    const indexed = new Map(records.map((record) => [record.id, record]));
    const remote = new RemoteScenePaths({
      get: (id) => indexed.get(id),
      query: () => undefined,
      prepareScenePaths: (...args) => {
        settled = session.prepare(...args);
        return settled;
      },
    });
    expect(remote.read(records[0]!, () => [])).toBe("pending");
    await settled;
    expect(Array.isArray(remote.read(records[0]!, () => []))).toBe(true);
    delayed = true;
    expect(remote.read(records[1]!, () => [records[2]!.id])).toBe("pending");
    remote.cancel((id) => id === records[2]!.id);
    release();
    await settled;
    expect(Array.isArray(remote.read(records[2]!, () => []))).toBe(true);
    expect(harness.runtime.instrumentation.shapeBuilds).toBe(2);
    expect(harness.runtime.instrumentation.shapeCacheElements).toBe(2);
    remote.cancel();
    port.terminate();
    harness.detach();
    expect(remote.memoryUsage()).toBe(0);
  },
);
