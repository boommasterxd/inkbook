import { describe, expect, it, vi } from "vitest";

import type { LineElementV1 } from "../../../../../src/domain/schema/public";
import { ElementStore } from "../../../../../src/domain/store/public";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { uuid } from "../../../domain/schema/fixtures";
import { connectedLine, rectangle } from "../../../domain/store/fixtures";

function graph() {
  const target = rectangle();
  const source = { ...connectedLine(target), startConnection: null };
  const dependent: LineElementV1 = {
    ...source,
    id: uuid(100),
    startConnection: {
      anchor: { kind: "linear-endpoint", endpoint: "start" },
      targetId: source.id,
    },
    endConnection: {
      anchor: { kind: "linear-endpoint", endpoint: "end" },
      targetId: source.id,
    },
  };
  const store = new ElementStore([target, source, dependent]);
  return { dependent, source, store, scene: new ElementSceneStore(store), target };
}

function suspendedWorkScheduler() {
  let resume: (() => void) | undefined;
  return {
    resume: () => resume?.(),
    scheduler: {
      ...immediateWorkScheduler(),
      shouldYield: () => resume === undefined,
      checkpoint: () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    },
  };
}

describe("prepared snap connection cycles", () => {
  it("releases completed gesture reachability on abort without clearing a replacement source", async () => {
    const { source, scene, target } = graph();
    const signal = new AbortController();
    const scheduler = immediateWorkScheduler();
    await scene.prepareConnections(source.id, scheduler, signal.signal);
    signal.abort();
    expect(scene.canConnect(source.id, target.id)).toBe(false);
    const previous = new AbortController();
    await scene.prepareConnections(source.id, scheduler, previous.signal);
    await scene.prepareConnections(target.id, scheduler);
    previous.abort();
    expect(scene.canConnect(target.id, source.id)).toBe(true);
    scene.release();
  });
  it("rejects both endpoint dependencies and self, retaining preparation across paint and order changes", async () => {
    const { dependent, source, store, scene, target } = graph();
    const scheduler = immediateWorkScheduler();
    expect(scene.canConnect(source.id, target.id)).toBe(false);
    expect(await scene.prepareConnections(source.id, scheduler)).toBe(true);
    expect(scene.canConnect(source.id, target.id)).toBe(true);
    expect(scene.canConnect(source.id, source.id)).toBe(false);
    expect(scene.canConnect(source.id, dependent.id)).toBe(false);
    expect(store.instrumentation.reverseDependencyVisits).toBe(2);

    store.updateStyle(source.id, { ...source.style, outlineWidth: 8 });
    store.arrange(new Set([source.id]), "send-backward");
    store.resetInstrumentation();
    expect(await scene.prepareConnections(source.id, scheduler)).toBe(true);
    expect(scene.canConnect(source.id, dependent.id)).toBe(false);
    expect(store.instrumentation.reverseDependencyVisits).toBe(0);
    scene.release();
  });

  it("invalidates connections and membership, replaces the cached source, and releases listeners", async () => {
    const { dependent, source, store, scene, target } = graph();
    const scheduler = immediateWorkScheduler();
    await scene.prepareConnections(source.id, scheduler);
    store.replace(dependent.id, { ...dependent, startConnection: null, endConnection: null });
    expect(scene.canConnect(source.id, target.id)).toBe(false);
    await scene.prepareConnections(source.id, scheduler);
    expect(scene.canConnect(source.id, dependent.id)).toBe(true);
    store.create(rectangle(uuid(200)));
    expect(scene.canConnect(source.id, target.id)).toBe(false);
    await scene.prepareConnections(target.id, scheduler);
    expect(scene.canConnect(source.id, target.id)).toBe(false);
    expect(scene.canConnect(target.id, source.id)).toBe(true);
    store.remove([dependent.id]);
    expect(scene.canConnect(target.id, source.id)).toBe(false);
    scene.release();
    expect(await scene.prepareConnections(source.id, scheduler)).toBe(false);
    expect(scene.canConnect(source.id, target.id)).toBe(false);
  });
});

describe("snap cycle preparation cancellation", () => {
  it("retains suspended-work reservations until cancellation settles, notifying only actual byte changes", async () => {
    const { dependent, source, store } = graph();
    const changed = vi.fn();
    const scene = new ElementSceneStore(store, changed);
    const { resume, scheduler } = suspendedWorkScheduler();
    const pending = scene.prepareConnections(source.id, scheduler);
    expect(scene.memoryUsage().selectionGeometryCacheBytes).toBe(512);
    const replacement = scene.prepareConnections(dependent.id, scheduler);
    expect(scene.memoryUsage().selectionGeometryCacheBytes).toBe(1024);
    scene.setActiveDocumentMemoryPressure(true);
    scene.clearConnections();
    scene.release();
    expect(scene.memoryUsage().selectionGeometryCacheBytes).toBe(1024);
    expect(changed).toHaveBeenCalledTimes(2);
    resume();
    expect(await Promise.all([pending, replacement])).toEqual([false, false]);
    expect(scene.memoryUsage().selectionGeometryCacheBytes).toBe(0);
    expect(changed).toHaveBeenCalledTimes(4);
  });
  it.each(["abort", "clear", "release", "mutation"] as const)(
    "discards suspended preparation after %s",
    async (action) => {
      const { source, store, scene, target } = graph();
      const signal = new AbortController();
      const { resume, scheduler } = suspendedWorkScheduler();
      const pending = scene.prepareConnections(source.id, scheduler, signal.signal);
      expect(scene.prepareConnections(source.id, scheduler, signal.signal)).toBe(pending);
      if (action === "abort") signal.abort();
      if (action === "clear") scene.clearConnections();
      if (action === "release") scene.release();
      if (action === "mutation") store.remove([target.id]);
      resume();
      expect(await pending).toBe(false);
      expect(scene.canConnect(source.id, target.id)).toBe(false);
      expect(store.instrumentation.reverseDependencyVisits).toBe(0);
      scene.release();
    },
  );

  it("propagates scheduler failures and closes the suspended reverse iterator", async () => {
    const { source, store, scene } = graph();
    const close = vi.fn();
    vi.spyOn(store, "beginDependents").mockImplementation(function* () {
      try {
        yield { endpoint: "start", linearId: uuid(300) };
      } finally {
        close();
      }
    });
    let checkpoints = 0;
    const error = new Error("Scheduler failure");
    const scheduler = {
      ...immediateWorkScheduler(),
      shouldYield: () => ++checkpoints > 1,
      checkpoint: () => Promise.reject(error),
    };
    await expect(scene.prepareConnections(source.id, scheduler)).rejects.toBe(error);
    expect(close).toHaveBeenCalledOnce();
    scene.release();
  });
});
