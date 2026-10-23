import { describe, expect, it, vi } from "vitest";

import type { LineElementV1 } from "../../../../../src/domain/schema/public";
import { ElementStore } from "../../../../../src/domain/store/public";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { uuid } from "../../../../unit/domain/schema/fixtures";
import { connectedLine } from "../../../../unit/domain/store/fixtures";

function connectionGraph(size = 10_000, chainSize = 8_000): LineElementV1[] {
  const source = { ...connectedLine(), id: uuid(40_000), startConnection: null };
  const elements: LineElementV1[] = [source];
  for (let index = 1; index < size; index += 1) {
    const targetId =
      index < chainSize
        ? elements[index - 1]!.id
        : elements[Math.floor((index - chainSize) / 125)]!.id;
    elements.push({
      ...source,
      id: uuid(40_000 + index),
      startConnection: {
        anchor: { kind: "linear-endpoint", endpoint: "start" },
        targetId,
      },
      endConnection:
        index < chainSize
          ? null
          : {
              anchor: { kind: "linear-endpoint", endpoint: "end" },
              targetId,
            },
    });
  }
  return elements;
}

describe("snap cycle work", () => {
  it("visits each reverse edge once across a 10,000-element chain and fanout, reusing every candidate lookup", async () => {
    const elements = connectionGraph();
    const source = elements[0]!;
    const store = new ElementStore(elements);
    const scene = new ElementSceneStore(store);
    const read = vi.spyOn(store, "get");
    const scheduler = immediateWorkScheduler();
    store.resetInstrumentation();
    expect(await scene.prepareConnections(source.id, scheduler)).toBe(true);
    expect(store.instrumentation.reverseDependencyVisits).toBe(11_999);
    expect(read).not.toHaveBeenCalled();
    for (const candidate of elements) expect(scene.canConnect(source.id, candidate.id)).toBe(false);
    expect(scene.canConnect(source.id, uuid(70_000))).toBe(true);
    expect(await scene.prepareConnections(source.id, scheduler)).toBe(true);
    expect(store.instrumentation.reverseDependencyVisits).toBe(11_999);
    expect(read).not.toHaveBeenCalled();
    expect(store.instrumentation.fullStoreScans).toBe(0);

    scene.clearConnections();
    store.resetInstrumentation();
    const leafId = elements[elements.length - 1]!.id;
    expect(await scene.prepareConnections(leafId, scheduler)).toBe(true);
    expect(scene.canConnect(source.id, leafId)).toBe(false);
    expect(scene.canConnect(leafId, source.id)).toBe(true);
    expect(store.instrumentation.reverseDependencyVisits).toBe(0);
    scene.release();
    expect(scene.canConnect(leafId, source.id)).toBe(false);
  });

  it("yields inside a wide reverse fanout and drops cancelled partial results without record reads", async () => {
    const store = new ElementStore(connectionGraph());
    const scene = new ElementSceneStore(store);
    const read = vi.spyOn(store, "get");
    store.resetInstrumentation();
    const signal = new AbortController();
    const observedSlices: number[] = [];
    let sliceStart = 0;
    const scheduler = {
      ...immediateWorkScheduler(),
      shouldYield: () => store.instrumentation.reverseDependencyVisits - sliceStart >= 32,
      checkpoint: () => {
        observedSlices.push(store.instrumentation.reverseDependencyVisits - sliceStart);
        sliceStart = store.instrumentation.reverseDependencyVisits;
        signal.abort();
        return Promise.resolve();
      },
    };
    const sourceId = uuid(40_000);
    expect(await scene.prepareConnections(sourceId, scheduler, signal.signal)).toBe(false);
    expect(observedSlices).toEqual([32]);
    expect(store.instrumentation.reverseDependencyVisits).toBe(32);
    expect(read).not.toHaveBeenCalled();
    expect(scene.canConnect(sourceId, uuid(70_000))).toBe(false);
    expect(await scene.prepareConnections(sourceId, immediateWorkScheduler())).toBe(true);
    expect(store.instrumentation.reverseDependencyVisits).toBe(12_031);
    scene.release();
  });
});

describe("snap cycle memory ownership", () => {
  it("accounts for document-capacity preparation and completed sets, then releases on pressure", async () => {
    const store = new ElementStore(connectionGraph(20_000, 20_000));
    const changed = vi.fn();
    const scene = new ElementSceneStore(store, changed);
    const scheduler = immediateWorkScheduler();
    const sourceId = uuid(40_000);
    const pending = scene.prepareConnections(sourceId, scheduler);
    expect(scene.memoryUsage().selectionGeometryCacheBytes).toBe(1_280_320);
    expect(changed).toHaveBeenCalledOnce();
    expect(await pending).toBe(true);
    expect(scene.memoryUsage().selectionGeometryCacheBytes).toBe(960_128);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(await scene.prepareConnections(sourceId, scheduler)).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
    scene.setActiveDocumentMemoryPressure(true);
    expect(scene.memoryUsage().selectionGeometryCacheBytes).toBe(0);
    expect(changed).toHaveBeenCalledTimes(3);
    expect(await scene.prepareConnections(sourceId, scheduler)).toBe(false);
    scene.setActiveDocumentMemoryPressure(false);
    expect(await scene.prepareConnections(sourceId, scheduler)).toBe(true);
    scene.release();
    expect(scene.memoryUsage().selectionGeometryCacheBytes).toBe(0);
    expect(changed).toHaveBeenCalledTimes(6);
  });
});
