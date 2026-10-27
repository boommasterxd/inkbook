import { expect } from "vitest";
import type { InkElementV1 } from "../../../src/domain/schema/public";
import type { SvgSceneRenderer } from "../../../src/rendering/scene";
import type { SceneViewport } from "../../../src/rendering/scene/types";
import { line } from "../../unit/domain/schema/fixtures";
import { FakeSceneStore, type FakeScheduler } from "../../unit/rendering/scene/fakes";
import { createWorkerSnapshot } from "../persistence/worker-snapshot";
import { createSceneFixture, createSceneRecord } from "./scene";
import { expectReleasedPublicationScene } from "./scene-publication";

export function connectedPreviewLine(index: number) {
  return {
    ...line(20_000 + index),
    pivot: { x: 25, y: 25 },
    start: { x: 20, y: 20 },
    end: { x: 30, y: 30 },
  };
}

export function connectedPreviewElements(count: number) {
  return Array.from({ length: count }, (_, index) => connectedPreviewLine(index));
}

export function connectedPreviewMap(count: number) {
  return new Map(connectedPreviewElements(count).map((element) => [element.id, element] as const));
}

export function createSettledPreviewScene(store: FakeSceneStore, viewport?: SceneViewport) {
  const scene = createSceneFixture(createWorkerSnapshot([]).page, store, viewport);
  scene.renderer.setReducedMotion(true);
  scene.scheduler.runAll();
  return scene;
}

export function createConnectedPreviewScene(
  elements: readonly InkElementV1[],
  viewport?: SceneViewport,
) {
  const store = new FakeSceneStore();
  for (const [rank, element] of elements.entries())
    store.records.set(element.id, createSceneRecord(element, rank));
  return { ...createSettledPreviewScene(store, viewport), store };
}

/** Observes actual source-index reads while charging the existing shared frame clock. */
export function observePreviewIds(ids: readonly string[], scheduler: FakeScheduler) {
  const work = { visits: 0 };
  const observed = new Proxy(ids, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) {
        work.visits += 1;
        scheduler.time += 1;
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return { ids: observed, work };
}

export function expectReleasedPreviewScene(
  renderer: SvgSceneRenderer,
  scheduler: FakeScheduler,
): void {
  expectReleasedPublicationScene(renderer, scheduler);
  expect(renderer.memoryUsage().motionCacheBytes).toBe(0);
}
