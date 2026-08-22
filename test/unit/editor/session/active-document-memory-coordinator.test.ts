import { describe, expect, it, vi } from "vitest";

import {
  ActiveDocumentMemoryCoordinator,
  type ActiveDocumentMemoryScenePort,
  type ActiveDocumentMemoryStorePort,
  type ActiveDocumentMemoryUsage,
} from "../../../../src/editor/session/active-document-memory-coordinator";

describe("active document memory coordination", () => {
  it("applies pressure to both cache owners before the ceiling and releases with hysteresis", () => {
    const usage = {
      anchorCacheBytes: 10,
      modelBytes: 50,
      motionCacheBytes: 5,
      pathCacheBytes: 34,
    };
    const harness = memoryHarness(usage);

    harness.coordinator.evaluate();
    expect(harness.storePressure).not.toHaveBeenCalled();
    usage.pathCacheBytes += 1;
    harness.coordinator.evaluate();
    expect(harness.coordinator.active).toBe(true);
    expect(harness.storePressure).toHaveBeenLastCalledWith(true);
    expect(harness.scenePressure).toHaveBeenLastCalledWith(true);

    usage.anchorCacheBytes = 0;
    usage.motionCacheBytes = 0;
    usage.pathCacheBytes = 0;
    harness.coordinator.evaluate();
    expect(harness.coordinator.active).toBe(false);
    expect(harness.storePressure).toHaveBeenLastCalledWith(false);
    expect(harness.scenePressure).toHaveBeenLastCalledWith(false);
  });

  it("releases an active coordinator exactly once and validates thresholds", () => {
    const usage: ActiveDocumentMemoryUsage = {
      anchorCacheBytes: 10,
      modelBytes: 100,
      motionCacheBytes: 0,
      pathCacheBytes: 0,
    };
    const harness = memoryHarness(usage);
    harness.coordinator.evaluate();

    harness.coordinator.release();
    harness.coordinator.release();

    expect(harness.storePressure).toHaveBeenCalledTimes(2);
    expect(harness.scenePressure).toHaveBeenCalledTimes(2);
    expect(harness.coordinator.evaluate()).toEqual({
      anchorCacheBytes: 0,
      modelBytes: 0,
      motionCacheBytes: 0,
      pathCacheBytes: 0,
    });
    expect(
      () =>
        new ActiveDocumentMemoryCoordinator({
          pressureBytes: 10,
          releaseBytes: 10,
          scene: harness.scene,
          store: harness.store,
        }),
    ).toThrow(RangeError);
  });
});

interface MemoryHarness {
  readonly coordinator: ActiveDocumentMemoryCoordinator;
  readonly scene: ActiveDocumentMemoryScenePort;
  readonly scenePressure: ReturnType<typeof vi.fn>;
  readonly store: ActiveDocumentMemoryStorePort;
  readonly storePressure: ReturnType<typeof vi.fn>;
}

function memoryHarness(usage: ActiveDocumentMemoryUsage): MemoryHarness {
  const store = memoryStore(usage);
  const scene = memoryScene(usage);
  return {
    coordinator: new ActiveDocumentMemoryCoordinator({
      pressureBytes: 100,
      releaseBytes: 60,
      scene: scene.port,
      store: store.port,
    }),
    scene: scene.port,
    scenePressure: scene.setPressure,
    store: store.port,
    storePressure: store.setPressure,
  };
}

function memoryStore(usage: ActiveDocumentMemoryUsage): {
  readonly port: ActiveDocumentMemoryStorePort;
  readonly setPressure: ReturnType<typeof vi.fn>;
} {
  const setPressure = vi.fn();
  return {
    port: {
      memoryUsage: () => usage,
      setActiveDocumentMemoryPressure: setPressure,
    },
    setPressure,
  };
}

function memoryScene(usage: ActiveDocumentMemoryUsage): {
  readonly port: ActiveDocumentMemoryScenePort;
  readonly setPressure: ReturnType<typeof vi.fn>;
} {
  const setPressure = vi.fn();
  return {
    port: {
      memoryUsage: () => usage,
      setActiveDocumentMemoryPressure: setPressure,
    },
    setPressure,
  };
}
