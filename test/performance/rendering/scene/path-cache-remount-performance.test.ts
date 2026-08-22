import { expect, it } from "vitest";

import type { PageV1 } from "../../../../src/domain/schema/public";
import { SvgSceneRenderer, type SceneElementRecord } from "../../../../src/rendering/scene";
import {
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  FakeScheduler,
  asElement,
  fakeRectangleRecord,
} from "../../../unit/rendering/scene/fakes";

const BATCH_SIZE = 700;
const BATCH_OFFSETS = [0, 1_000, 2_000] as const;
const PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2_000,
  lockedBufferLines: 1,
  margin: 24.3,
  writingLineHeight: 100,
};

it("remounts a batch after retaining more than 2,048 paths without geometry rebuilds", async ({
  annotate,
}) => {
  const document = new FakeDocument();
  const scheduler = new FakeScheduler();
  const store = new FakeSceneStore();
  for (let batch = 0; batch < BATCH_OFFSETS.length; batch += 1) {
    const offset = BATCH_OFFSETS[batch]!;
    for (let index = 0; index < BATCH_SIZE; index += 1) {
      const rank = batch * BATCH_SIZE + index;
      const id = `cached-path-${String(rank).padStart(4, "0")}`;
      store.records.set(id, fakeRectangleRecord(id, rank, offset + 10));
    }
  }
  const renderer = new SvgSceneRenderer({
    container: asElement(new FakeNode(document, "div")),
    layout: { readViewport: () => ({ height: 100, left: 0, top: 0, width: 100 }) },
    page: PAGE,
    scheduler,
    store,
  });

  scheduler.runAll();
  for (const offset of BATCH_OFFSETS.slice(1)) showOffset(renderer, scheduler, offset);
  showOffset(renderer, scheduler, 3_000);
  expect(renderer.instrumentation().pathCacheEntries).toBe(2_100);

  renderer.resetInstrumentation();
  showOffset(renderer, scheduler, 0);

  expect(renderer.instrumentation()).toMatchObject({
    geometryBuilds: 0,
    pathCacheHits: BATCH_SIZE,
  });
  await annotate("2,100 retained paths, 700 remount hits, 0 geometry builds", "performance");
});

it("counts exact paint writes and reuses background geometry across repaint work", async ({
  annotate,
}) => {
  const document = new FakeDocument();
  const scheduler = new FakeScheduler();
  const store = new FakeSceneStore();
  const initial = fakeRectangleRecord("painted", 0, 10);
  store.records.set(initial.id, initial);
  const linedPage: PageV1 = { ...PAGE, background: { spacing: 20, type: "squares" } };
  const renderer = new SvgSceneRenderer({
    container: asElement(new FakeNode(document, "div")),
    layout: { readViewport: () => ({ height: 100, left: 0, top: 0, width: 100 }) },
    page: linedPage,
    scheduler,
    store,
  });
  scheduler.runAll();

  if (initial.element.kind !== "rectangle") throw new Error("Expected a rectangle fixture.");
  const painted: SceneElementRecord = {
    ...initial,
    element: {
      ...initial.element,
      style: { ...initial.element.style, outlineOpacity: 0.5 },
    },
    paintVersion: 2,
  };
  store.records.set(initial.id, painted);
  renderer.resetInstrumentation();
  renderer.applyDelta({ affected: [{ domains: ["paint"], id: initial.id }] });
  scheduler.runAll();
  expect(renderer.instrumentation()).toMatchObject({
    contentAttributeWrites: 1,
    contentGeometryWrites: 0,
    geometryBuilds: 0,
  });

  store.records.set(initial.id, { ...painted, paintVersion: 3 });
  renderer.resetInstrumentation();
  renderer.applyDelta({ affected: [{ domains: ["paint"], id: initial.id }] });
  scheduler.runAll();
  expect(renderer.instrumentation().contentAttributeWrites).toBe(0);

  renderer.resetInstrumentation();
  renderer.setPage({ ...linedPage }, 100);
  scheduler.runAll();
  expect(renderer.instrumentation()).toMatchObject({
    backgroundBuilds: 0,
    backgroundCacheHits: 1,
    contentAttributeWrites: 0,
  });

  renderer.resetInstrumentation();
  renderer.setScheme("dark");
  scheduler.runAll();
  expect(renderer.instrumentation()).toMatchObject({
    backgroundBuilds: 0,
    contentAttributeWrites: 0,
    themeWrites: 1,
  });
  await annotate(
    "renderer writes: changedPaint=1, unchangedPaint=0, backgroundCacheHits=1, themeBuilds=0",
    "performance",
  );
});

function showOffset(renderer: SvgSceneRenderer, scheduler: FakeScheduler, offset: number): void {
  renderer.setCamera({ x: -offset, zoom: 1 });
  scheduler.runAll();
}
