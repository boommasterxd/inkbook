import { expect, it, vi } from "vitest";

import type { BoxShapeElementV1, PageV1 } from "../../../../src/domain/schema/public";
import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { SCENE_PUBLICATION_ROOTS_PER_FRAME } from "../../../../src/rendering/scene/constants";
import { createSceneFixture, QueryCostStore } from "../../../fixtures/rendering/scene";
import {
  FakeSceneStore,
  FakeScheduler,
  FakeDocument,
  FakeNode,
  asElement,
  fakeNode,
  fakeRectangleRecord,
} from "../../../unit/rendering/scene/fakes";

const PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2_000,
  lockedBufferLines: 1,
  margin: 24.3,
};

const VIEWPORT = { height: 100, left: 0, top: 0, width: 100 };

it("reuses detached SVG roots when the viewport returns", () => {
  const store = new FakeSceneStore();
  store.records.set("first", fakeRectangleRecord("first", 0, 10));
  store.records.set("second", fakeRectangleRecord("second", 1, 10));
  const { renderer, scheduler } = createSceneFixture(PAGE, store, VIEWPORT);
  scheduler.runAll();
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  const roots = [...content.nodes];
  expect(renderer.instrumentation()).toMatchObject({ domRootsPublished: 2, domFragmentRuns: 1 });
  renderer.setViewport({ ...VIEWPORT, top: 500 });
  scheduler.runAll();
  expect(content.nodes).toHaveLength(0);
  expect(roots.every((node) => node.parent === undefined)).toBe(true);
  renderer.resetInstrumentation();
  renderer.setViewport(VIEWPORT);
  scheduler.runAll();
  expect(content.nodes).toEqual(roots);
  expect(renderer.instrumentation()).toMatchObject({
    domRootsPublished: 2,
    domFragmentRuns: 1,
    geometryBuilds: 0,
    detachedCacheHits: 2,
  });
  renderer.destroy();
});

function createThemeScene() {
  const parentDocument = new FakeDocument();
  const scheduler = new FakeScheduler();
  const tokens = new Map([["--interactive-accent", "#123456"]]);
  const read = vi.fn(() => ({
    width: "512.5px",
    height: "900.25px",
    getPropertyValue: (property: string) => tokens.get(property) ?? "",
  }));
  let mutation = (): void => undefined;
  const disconnect = vi.fn();
  class ThemeObserver {
    public constructor(callback: () => void) {
      mutation = callback;
    }
    public observe(): void {}
    public readonly disconnect = disconnect;
  }
  Object.defineProperty(parentDocument, "defaultView", {
    value: { getComputedStyle: read, MutationObserver: ThemeObserver },
  });
  const renderer = new SvgSceneRenderer({
    container: asElement(new FakeNode(parentDocument, "div")),
    layout: { readViewport: () => VIEWPORT },
    page: PAGE,
    store: new FakeSceneStore(),
    workScheduler: scheduler.workScheduler,
  });
  return { renderer, scheduler, tokens, read, disconnect, mutate: () => mutation() };
}

it("coalesces host mutations and same-scheme theme refreshes through the central scene frame", () => {
  const h = createThemeScene();
  const drawing = fakeNode(h.renderer.svg).ownerDocument;
  try {
    h.scheduler.runAll();
    expect(drawing.body.style.getPropertyValue("--interactive-accent")).toBe("#123456");
    const writes = vi.spyOn(drawing.body.style, "setProperty");
    const transitions = [
      {
        property: "--interactive-accent",
        value: "#654321",
        refresh: () => h.renderer.setScheme("light"),
      },
      {
        property: "--inkbook-scene-foreground-visibility",
        value: "hidden",
        refresh: h.mutate,
      },
    ];
    for (const { property, value, refresh } of transitions) {
      writes.mockClear();
      h.read.mockClear();
      h.renderer.resetInstrumentation();
      h.tokens.set(property, value);
      for (let sample = 0; sample < 8; sample += 1) refresh();
      expect(h.scheduler.pendingCount).toBe(1);
      expect(h.read).not.toHaveBeenCalled();
      h.scheduler.runAll();
      expect(h.read).toHaveBeenCalledOnce();
      expect(writes).toHaveBeenCalledExactlyOnceWith(property, value);
      expect(h.renderer.instrumentation()).toMatchObject({ scheduledFrames: 1, themeWrites: 0 });
    }
    writes.mockRestore();
  } finally {
    h.renderer.destroy();
  }
  expect(h.disconnect).toHaveBeenCalledOnce();
  h.mutate();
  expect(h.scheduler.pendingCount).toBe(0);
});

class ReadCostStore extends FakeSceneStore {
  public constructor(private readonly scheduler: FakeScheduler) {
    super();
  }

  public override get(id: string) {
    this.scheduler.time += 1;
    return super.get(id);
  }
}

it("defers a second scene when the first consumes the shared window deadline", () => {
  const scheduler = new FakeScheduler();
  const firstStore = new QueryCostStore(scheduler);
  const secondStore = new FakeSceneStore();
  firstStore.records.set("first", fakeRectangleRecord("first", 0, 10));
  secondStore.records.set("second", fakeRectangleRecord("second", 0, 10));
  const first = createSceneFixture(PAGE, firstStore, VIEWPORT, {}, scheduler);
  const second = createSceneFixture(PAGE, secondStore, VIEWPORT, {}, scheduler);

  expect(scheduler.pendingCount).toBe(1);
  scheduler.runNext();
  expect(first.renderer.instrumentation().spatialQueries).toBe(1);
  // Exhausted indexed acquisition defers classification and publication to the next frame.
  expect(first.renderer.mountedCount).toBe(0);
  expect(first.renderer.instrumentation().visibilityReconcileVisits).toBe(0);
  expect(second.renderer.instrumentation().spatialQueries).toBe(0);
  expect(scheduler.pendingCount).toBe(1);

  scheduler.runAll();
  expect(first.renderer.mountedIds("content")).toEqual(["first"]);
  expect(second.renderer.mountedIds("content")).toEqual(["second"]);
  expect(scheduler.pendingCount).toBe(0);
  first.renderer.destroy();
  second.renderer.destroy();
});

it("cancels one scene without discarding another scene's queued frame", () => {
  const scheduler = new FakeScheduler();
  const first = createSceneFixture(PAGE, new FakeSceneStore(), VIEWPORT, {}, scheduler);
  const secondStore = new FakeSceneStore();
  secondStore.records.set("second", fakeRectangleRecord("second", 0, 10));
  const second = createSceneFixture(PAGE, secondStore, VIEWPORT, {}, scheduler);

  first.renderer.destroy();
  expect(scheduler.pendingCount).toBe(1);
  scheduler.runAll();
  expect(second.renderer.mountedIds("content")).toEqual(["second"]);
  expect(scheduler.pendingCount).toBe(0);
  second.renderer.destroy();
});

it("shares bounded SVG publication while both scenes advance under late host frames", () => {
  const scheduler = new FakeScheduler();
  const stores = [new FakeSceneStore(), new FakeSceneStore()];
  for (const [sceneIndex, store] of stores.entries()) {
    for (let index = 0; index < 24; index += 1) {
      const id = `scene-${String(sceneIndex)}-${String(index)}`;
      store.records.set(id, fakeRectangleRecord(id, index, 10));
    }
  }
  const scenes = stores.map((store) => createSceneFixture(PAGE, store, VIEWPORT, {}, scheduler));
  let pathCreations = 0;
  let publications = 0;
  let roots = 0;
  for (const scene of scenes) {
    const content = fakeNode(scene.renderer.svg).nodes[1]!.nodes[4]!;
    const insert = content.insertBefore.bind(content);
    vi.spyOn(content, "insertBefore").mockImplementation((node, successor) => {
      publications += 1;
      roots += node.fragment ? node.nodes.length : 1;
      const result = insert(node, successor);
      scheduler.time += 9;
      return result;
    });
    const create = scene.document.createElementNS.bind(scene.document);
    vi.spyOn(scene.document, "createElementNS").mockImplementation((namespace, tag) => {
      const node = create(namespace, tag);
      if (tag === "path") {
        pathCreations += 1;
        scheduler.time += 9;
      }
      return node;
    });
  }
  vi.spyOn(scheduler, "now").mockImplementation(() => scheduler.time + 12);
  let previousPaths = 0;
  for (let frame = 0; scheduler.pendingCount > 0; frame += 1) {
    if (frame >= 100) throw new Error("Late scene work did not finish.");
    scheduler.time = frame * 16;
    publications = 0;
    roots = 0;
    scheduler.runNext();
    expect(publications).toBeLessThanOrEqual(1);
    expect(roots).toBeLessThanOrEqual(SCENE_PUBLICATION_ROOTS_PER_FRAME);
    expect(pathCreations - previousPaths).toBeLessThanOrEqual(1);
    if (pathCreations === 24)
      expect(scenes.every((scene) => scene.renderer.mountedCount > 0)).toBe(true);
    previousPaths = pathCreations;
  }
  expect(scenes.map((scene) => scene.renderer.mountedCount)).toEqual([24, 24]);
  expect(pathCreations).toBe(48);
  for (const scene of scenes) scene.renderer.destroy();
});

it("writes a paint-only dirty queue when its admitted frame starts late", () => {
  const scheduler = new FakeScheduler();
  const store = new FakeSceneStore();
  store.records.set("paint", fakeRectangleRecord("paint", 0, 10));
  const { renderer } = createSceneFixture(PAGE, store, VIEWPORT, {}, scheduler);
  scheduler.runAll();
  renderer.resetInstrumentation();
  const before = store.records.get("paint")!;
  const element = before.element as BoxShapeElementV1;
  store.records.set("paint", {
    ...before,
    element: {
      ...element,
      style: { ...element.style, outlineOpacity: 0.5 },
    },
    paintVersion: 2,
  });
  renderer.applyDelta({ affected: [{ domains: ["paint"], id: "paint" }] });
  vi.spyOn(scheduler, "now").mockImplementation(() => scheduler.time + 12);
  scheduler.time = 16;
  scheduler.runNext();
  expect(renderer.instrumentation().contentAttributeWrites).toBe(1);
  expect(renderer.hasPendingSceneCommit).toBe(false);
  renderer.destroy();
});

it("services preview and background while visible content is still mounting", () => {
  const scheduler = new FakeScheduler();
  const store = new ReadCostStore(scheduler);
  for (let index = 0; index < 200; index += 1) {
    const id = `visible-${String(index)}`;
    store.records.set(id, fakeRectangleRecord(id, index, 10));
  }
  const page: PageV1 = { ...PAGE, background: { spacing: 25, type: "dots" } };
  const { renderer } = createSceneFixture(page, store, VIEWPORT, {}, scheduler);
  const element = store.records.get("visible-0")!.element;
  let materializations = 0;
  renderer.setProgressiveElementPreviews(
    [element.id],
    () => {
      materializations += 1;
      return element;
    },
    1,
  );

  scheduler.runNext();
  expect(renderer.mountedCount).toBeLessThan(store.records.size);
  expect(renderer.hasPendingSceneCommit).toBe(true);
  scheduler.runNext();
  expect(materializations).toBe(1);
  // Query classification now shares the frame deadline; background admission waits for it.
  let frames = 0;
  while (renderer.instrumentation().backgroundBuilds === 0) {
    if (++frames > 100) throw new Error("Background work did not finish during reconciliation.");
    scheduler.runNext();
  }
  expect(renderer.instrumentation().backgroundBuilds).toBe(1);
  expect(renderer.mountedCount).toBeLessThan(store.records.size);
  expect(renderer.hasPendingSceneCommit).toBe(true);

  scheduler.runAll();
  expect(renderer.mountedCount).toBe(store.records.size);
  expect(renderer.hasPendingSceneCommit).toBe(false);
  renderer.destroy();
});
