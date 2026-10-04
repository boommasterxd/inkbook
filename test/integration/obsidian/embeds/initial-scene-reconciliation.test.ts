import { expect, it, vi } from "vitest";

import { readActiveSceneViewport } from "../../../../src/obsidian/embeds/active-scene-viewport";
import type { BrowserScrollElement } from "../../../../src/obsidian/scrolling";
import { InitialSceneReadiness } from "../../../../src/obsidian/embeds/initial-scene-readiness";
import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import {
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  FakeScheduler,
  asElement,
  fakeRectangleRecord,
} from "../../../unit/rendering/scene/fakes";

it("keeps initial handoff hidden while final viewport reconciliation spans multiple frames", () => {
  const scheduler = new FakeScheduler();
  const store = new FakeSceneStore();
  for (let index = 0; index < 20; index += 1) {
    const id = `rectangle-${String(index)}`;
    store.records.set(id, fakeRectangleRecord(id, index, 10 + index / 1_000));
  }
  const readiness = new InitialSceneReadiness();
  const visible = vi.fn();
  const document = new FakeDocument();
  let viewport = { height: 100, left: 0, top: 10_000, width: 100 };
  const renderer = new SvgSceneRenderer({
    deferInitialOverscan: true,
    container: asElement(new FakeNode(document, "div")),
    layout: { readViewport: () => viewport },
    onSceneCommitted: () => {
      if (readiness.markSceneCommitted()) visible();
    },
    page: {
      activeBufferLines: 3,
      background: { type: "none" },
      innerWidth: 2_000,
      lockedBufferLines: 1,
      margin: 24.3,
    },
    workScheduler: scheduler.workScheduler,
    store,
  });
  scheduler.runAll();
  expect(renderer.instrumentation()).toMatchObject({ backgroundBuilds: 1 });
  expect(scheduler.pendingCount).toBe(0);
  expect(renderer.mountedCount).toBe(0);
  expect(visible).not.toHaveBeenCalled();

  let pathCreations = 0;
  const create = document.createElementNS.bind(document);
  const paths = vi.spyOn(document, "createElementNS").mockImplementation((namespace, tag) => {
    const node = create(namespace, tag);
    if (tag === "path") {
      pathCreations += 1;
      scheduler.time += 9;
    }
    return node;
  });

  renderer.setCamera({ x: 0, zoom: 0.5 });
  viewport = { height: 100, left: 0, top: 0, width: 100 };
  if (readiness.markLayoutReady()) renderer.invalidateLayout(true);
  scheduler.runNext();
  scheduler.runNext();
  scheduler.runNext();
  expect(pathCreations).toBeGreaterThan(0);
  expect(renderer.mountedCount).toBeLessThan(20);
  expect.soft(visible).not.toHaveBeenCalled();
  scheduler.runAll();
  expect(renderer.mountedCount).toBe(20);
  expect(pathCreations).toBe(20);
  expect(visible).toHaveBeenCalledOnce();
  paths.mockRestore();
  renderer.destroy();
});

it.each(["complete", "dispose-before-layout", "dispose-after-layout"] as const)(
  "preserves a commit requested inside an earlier callback: %s",
  (outcome) => {
    const scheduler = new FakeScheduler();
    const readiness = new InitialSceneReadiness();
    const visible = vi.fn();
    const document = new FakeDocument();
    let commits = 0;
    const renderer = new SvgSceneRenderer({
      deferInitialOverscan: true,
      container: asElement(new FakeNode(document, "div")),
      layout: { readViewport: () => ({ height: 100, left: 0, top: 0, width: 100 }) },
      onSceneCommitted: () => {
        commits += 1;
        if (readiness.markLayoutReady()) renderer.invalidateLayout(true);
        if (!renderer.hasPendingSceneCommit && readiness.markSceneCommitted()) visible();
      },
      page: {
        activeBufferLines: 3,
        background: { type: "none" },
        innerWidth: 2_000,
        lockedBufferLines: 1,
        margin: 24.3,
      },
      reducedMotion: true,
      workScheduler: scheduler.workScheduler,
      store: new FakeSceneStore(),
    });
    if (outcome === "dispose-before-layout") renderer.destroy();
    else {
      scheduler.runNext();
      expect(commits).toBe(1);
      expect(visible).not.toHaveBeenCalled();
      expect(renderer.hasPendingSceneCommit).toBe(true);
      if (outcome === "dispose-after-layout") renderer.destroy();
    }
    scheduler.runAll();
    expect(visible).toHaveBeenCalledTimes(outcome === "complete" ? 1 : 0);
    if (outcome === "complete") {
      expect(commits).toBe(2);
      renderer.destroy();
    }
  },
);

function growingClipHarness() {
  const scheduler = new FakeScheduler();
  const document = new FakeDocument();
  const classes = new Set(["inkbook-active-preparing"]);
  const root = {
    classList: {
      contains: (name: string) => classes.has(name),
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
    },
  } as unknown as HTMLElement;
  const container = asElement(new FakeNode(document, "div"));
  const bounds = { height: 40, left: 0, top: 0, width: 800 };
  Object.assign(container.style, { blockSize: "8000px" });
  container.getBoundingClientRect = () =>
    ({
      ...bounds,
      bottom: bounds.top + bounds.height,
      right: bounds.width,
    }) as DOMRect;
  const owner = {
    clientHeight: 800,
    get clientWidth() {
      return bounds.width;
    },
    ownerDocument: document,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 800 }),
  } as unknown as BrowserScrollElement;
  const store = new FakeSceneStore();
  for (let index = 0; index < 20; index += 1) {
    const id = `clip-rectangle-${String(index)}`;
    store.records.set(id, fakeRectangleRecord(id, index, 10 + index * 30, 10 + index * 30));
  }
  const committed = vi.fn();
  const renderer = new SvgSceneRenderer({
    container,
    layout: { readViewport: () => readActiveSceneViewport(container, owner, root) },
    onSceneCommitted: committed,
    page: {
      activeBufferLines: 3,
      background: { type: "none" },
      innerWidth: 2_000,
      lockedBufferLines: 1,
      margin: 24.3,
    },
    reducedMotion: true,
    workScheduler: scheduler.workScheduler,
    store,
  });
  return { bounds, committed, renderer, root, scheduler, store };
}

it("keeps prepared visibility unchanged through clip growth but tracks scrolling and width", () => {
  const h = growingClipHarness();
  h.renderer.invalidateLayout(true);
  h.scheduler.runAll();
  expect(h.renderer.mountedCount).toBe(20);
  expect(h.committed).toHaveBeenCalledOnce();
  const prepared = h.renderer.instrumentation();
  h.root.classList.remove("inkbook-active-preparing");
  h.root.classList.add("inkbook-active-transitioning");
  for (const height of [80, 200, 400, 800, 8000]) {
    h.bounds.height = height;
    h.renderer.invalidateLayout();
    h.scheduler.runAll();
    expect(h.renderer.instrumentation()).toMatchObject({
      spatialQueries: prepared.spatialQueries,
      geometryBuilds: prepared.geometryBuilds,
      backgroundBuilds: prepared.backgroundBuilds,
      domEntrants: prepared.domEntrants,
      domExits: prepared.domExits,
    });
  }
  h.bounds.top = -1600;
  h.renderer.invalidateLayout();
  h.scheduler.runAll();
  const scrolled = h.renderer.instrumentation().spatialQueries;
  expect(scrolled).toBeGreaterThan(prepared.spatialQueries);
  expect(h.renderer.mountedCount).toBeLessThan(20);
  const previousMaxX = h.store.lastQuery!.maxX;
  h.bounds.width = 1600;
  h.renderer.invalidateLayout();
  h.scheduler.runAll();
  expect(h.renderer.instrumentation().spatialQueries).toBeGreaterThan(scrolled);
  expect(h.store.lastQuery!.maxX).toBeGreaterThan(previousMaxX);
  expect(h.committed).toHaveBeenCalledOnce();
  h.renderer.destroy();
});
