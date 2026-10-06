import { expect, vi } from "vitest";
import type { SvgSceneRenderer } from "../../../src/rendering/scene";
import type { SceneStorePort, SceneViewport } from "../../../src/rendering/scene/types";
import type { FakeScheduler } from "../../unit/rendering/scene/fakes";
import {
  asElement,
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  fakeNode,
  fakeRectangleRecord,
} from "../../unit/rendering/scene/fakes";
import { SceneDom } from "../../../src/rendering/scene/scene-dom";
import { createInstrumentation } from "../../../src/rendering/scene/instrumentation";
import { createMountedElement, firstPath } from "../../../src/rendering/scene/mounted-element";
import { buildElementPathParts } from "../../../src/domain/geometry/element-path";
import { arrow, stroke } from "../../unit/domain/schema/fixtures";
import { SceneMountPreparation } from "../../../src/rendering/scene/scene-mount-preparation";
import { createSceneFixture, createSceneRecord } from "./scene";
import { NAVIGATION_PAGE } from "./pressure-navigation";

/** Places a detached entrant run between two physically retained rank anchors. */
export function createDirectPublicationScene(kind: "path" | "pressure" | "multipart" | "siblings") {
  const document = new FakeDocument();
  const dom = new SceneDom(asElement(new FakeNode(document, "div")), "Canvas", {});
  const instrumentation = createInstrumentation();
  const store = new FakeSceneStore();
  const record =
    kind === "path" || kind === "siblings"
      ? fakeRectangleRecord("singleton", 1, 20, 10)
      : createSceneRecord(kind === "pressure" ? stroke(40_000) : arrow(40_001), 1);
  const entries = [
    fakeRectangleRecord("before", 0, 10),
    record,
    ...(kind === "siblings" ? [fakeRectangleRecord("second", 1.5, 25, 10)] : []),
    fakeRectangleRecord("after", 2, 30),
  ].map((item) => {
    store.records.set(item.id, item);
    return createMountedElement(
      dom.ownerDocument,
      item,
      buildElementPathParts(item.element),
      instrumentation,
    );
  });
  const [before, entry, after] = [entries[0]!, entries[1]!, entries[entries.length - 1]!];
  const entrants = entries.slice(1, -1);
  const content = fakeNode(dom.contentGroup);
  content.append(fakeNode(firstPath(before)), fakeNode(firstPath(after)));
  return {
    document: content.ownerDocument,
    dom,
    instrumentation,
    store,
    before,
    entry,
    after,
    entrants,
    content,
  };
}

/** Starts with the existing navigation scene fully settled. */
export function createPublicationScene(store: SceneStorePort, viewport: SceneViewport) {
  const fixture = createSceneFixture(NAVIGATION_PAGE, store, viewport);
  fixture.scheduler.runAll();
  return { ...fixture, content: fakeNode(fixture.renderer.svg).nodes[1]!.nodes[4]! };
}

/** Charges preparation only when an original element is completely staged. */
export function observeCompletedMountPreparation(scheduler: FakeScheduler, at = 1) {
  const original = Object.getOwnPropertyDescriptor(SceneMountPreparation.prototype, "stage")!
    .value as SceneMountPreparation["stage"];
  let completed = 0;
  const stage = vi.spyOn(SceneMountPreparation.prototype, "stage").mockImplementation(function (
    this: SceneMountPreparation,
    ...args: Parameters<SceneMountPreparation["stage"]>
  ) {
    const entry = original.apply(this, args);
    if (entry !== undefined && ++completed === at) scheduler.time += 8;
    return entry;
  });
  return {
    stage,
    get completed() {
      return completed;
    },
  };
}

/** Owns the preparation and live-insert observers for an interrupted publication scene. */
export function createPreparedPublicationScene(store: SceneStorePort, viewport: SceneViewport) {
  const fixture = createPublicationScene(store, viewport);
  const insert = vi.spyOn(fixture.content, "insertBefore");
  const preparation = observeCompletedMountPreparation(fixture.scheduler);
  return { ...fixture, insert, preparation };
}

/** Drains central frames until the observed original elements have completed preparation. */
export function waitForPreparedMounts(
  scheduler: FakeScheduler,
  preparation: ReturnType<typeof observeCompletedMountPreparation>,
  count = 1,
): void {
  let remaining = 20;
  while (preparation.completed < count) {
    expect(remaining--).toBeGreaterThan(0);
    scheduler.runNext();
  }
}

/** Observes one real insertion into a live band, before its fragment becomes empty. */
export function observeSceneInsertions(content: FakeNode, published: (roots: number) => void) {
  const original = content.insertBefore.bind(content);
  return vi.spyOn(content, "insertBefore").mockImplementation((node, successor) => {
    const roots = node.fragment ? node.nodes.length : 1;
    const result = original(node, successor);
    published(roots);
    return result;
  });
}

/** Resolves an interrupted complete batch through its actual lifecycle boundary. */
export function settlePreparedPublication(
  renderer: SvgSceneRenderer,
  scheduler: FakeScheduler,
  action: string,
  previous: SceneViewport,
): void {
  if (action === "destroy") renderer.destroy();
  else {
    if (action === "retarget") renderer.setViewport(previous);
    scheduler.runAll();
  }
}

/** Begins one observed viewport frame with counters local to its publication. */
export function beginViewportPublication(
  renderer: SvgSceneRenderer,
  scheduler: FakeScheduler,
  viewport: SceneViewport,
) {
  renderer.resetInstrumentation();
  renderer.setViewport(viewport);
  scheduler.runNext();
  return renderer.instrumentation();
}

/** Observes each real scene publication, preserving its per-frame root resource cap. */
export function flushBoundedScenePublication(
  renderer: SvgSceneRenderer,
  scheduler: FakeScheduler,
  observe?: () => void,
): void {
  let previous = renderer.mountedCount;
  let frames = 0;
  while (scheduler.pendingCount > 0) {
    if (frames++ >= 100) throw new Error("Frame limit exceeded.");
    scheduler.runNext();
    expect(renderer.mountedCount - previous).toBeLessThanOrEqual(192);
    previous = renderer.mountedCount;
    observe?.();
  }
}

/** Makes subsequent work yield only after an actual DOM publication starts. */
export function chargeClockAfterPublication(content: FakeNode, scheduler: FakeScheduler) {
  let publicationStarted = false;
  const originalInsert = content.insertBefore.bind(content);
  const insert = vi.spyOn(content, "insertBefore").mockImplementation((node, successor) => {
    const result = originalInsert(node, successor);
    publicationStarted = true;
    return result;
  });
  const now = vi
    .spyOn(scheduler, "now")
    .mockImplementation(() => (publicationStarted ? (scheduler.time += 8) : scheduler.time));
  return () => {
    now.mockRestore();
    insert.mockRestore();
  };
}
