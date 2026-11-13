import { afterEach, expect, it, vi } from "vitest";
import { singleLineTextElement, textElement } from "../../../../fixtures/rendering/text";
import { createSceneRecord, createSceneFixture } from "../../../../fixtures/rendering/scene";
import { createInstrumentation } from "../../../../../src/rendering/scene/instrumentation";
import { SceneTextPreparation } from "../../../../../src/rendering/scene/content/scene-text-preparation";
import { createMountedElement } from "../../../../../src/rendering/scene/content/mounted-element";
import { MountSlice } from "../../../../../src/rendering/scene/reconciliation/mount-slice";
import { DetachedSceneElementCache } from "../../../../../src/rendering/scene/content/detached-element-cache";
import {
  asDocument,
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  fakeNode,
} from "../../../../unit/rendering/scene/fakes";
import { createWorkerSnapshot } from "../../../../fixtures/persistence/worker-snapshot";

afterEach(() => vi.restoreAllMocks());

function largeTextElement() {
  const row = "steady document text row value";
  const element = textElement({
    x: 50,
    y: 100,
    width: 300,
    height: 39_000,
    pivot: { x: 200, y: 19_600 },
    source: Array(3_000).fill(row).join("\n"),
  });
  element.style = { ...element.style, fontSize: 10 };
  element.layout.lines = Array.from({ length: 3_000 }, (_, index) => ({
    x: 0,
    y: index * 13,
    width: 200,
    height: 13,
    baseline: 10,
    runs: [
      {
        text: row,
        start: index * (row.length + 1),
        end: index * (row.length + 1) + row.length,
        x: 0,
        width: 200,
      },
    ],
  }));
  return element;
}

function nodes(node: FakeNode): FakeNode[] {
  return [node, ...node.nodes.flatMap(nodes)];
}

function largeTextScene() {
  const canonical = largeTextElement();
  const store = new FakeSceneStore();
  const record = createSceneRecord(canonical);
  store.records.set(canonical.id, record);
  const fixture = createSceneFixture(createWorkerSnapshot([]).page, store);
  fixture.renderer.setReducedMotion(true);
  fixture.scheduler.runAll();
  const initial = nodes(fakeNode(fixture.renderer.svg));
  const textRoot = initial.find((node) => node.getAttribute("class") === "inkbook-native-text")!;
  const content = textRoot.nodes[1]!;
  const overlay = initial.find(
    (node) => node.getAttribute("class") === "inkbook-selection-overlay",
  )!;
  return { ...fixture, canonical, store, record, content, overlay };
}

function observeNodeAllocations(document: FakeDocument, clock: { time: number }) {
  const create = document.createElementNS.bind(document);
  return vi.spyOn(document, "createElementNS").mockImplementation((...args) => {
    clock.time += 1;
    return create(...args);
  });
}

it("updates one owned clip for a 3000-line field only in coalesced scene frames", () => {
  const element = largeTextElement();
  const store = new FakeSceneStore();
  store.records.set(element.id, createSceneRecord(element));
  const { renderer, scheduler, document } = createSceneFixture(
    createWorkerSnapshot([]).page,
    store,
  );
  scheduler.runAll();
  const cameraGroup = fakeNode(renderer.svg).nodes.find((node) => node.tagName === "g")!;
  const content = cameraGroup.nodes.find((node) =>
    node.getAttribute("class")?.includes("inkbook-scene-content"),
  )!;
  const root = content.nodes[0]!;
  let camera = { x: 0, zoom: 1 };
  const read = vi.fn(() => ({
    a: camera.zoom,
    b: 0,
    c: 0,
    d: camera.zoom,
    e: camera.x * camera.zoom,
    f: 0,
  }));
  Object.defineProperty(root, "getScreenCTM", { value: read });
  Object.defineProperty(cameraGroup, "getScreenCTM", { value: read });
  const changed = vi.fn();
  const handle = renderer.beginTextEditing(element.id, { onViewportChanged: changed })!;
  const editing = root.nodes.find((node) => node.tagName === "foreignObject")!;
  const clip = editing.nodes.find(
    (node) => node.getAttribute("class") === "inkbook-text-editor-viewport",
  )!;
  expect(editing.parent).toBe(root);
  const additionalRead = vi.fn(() => {
    throw new Error("Editor viewport must reuse its text and camera CTMs.");
  });
  Object.defineProperty(editing, "getScreenCTM", { value: additionalRead });
  Object.defineProperty(fakeNode(renderer.svg), "getScreenCTM", { value: additionalRead });
  expect(read).not.toHaveBeenCalled();
  scheduler.runAll();
  read.mockClear();
  changed.mockClear();
  const created = vi.spyOn(document, "createElementNS");
  const writes = vi.spyOn(clip.style, "setProperty");
  const editorWrites = vi.spyOn(editing, "setAttribute");
  try {
    renderer.setViewport({ left: 0, top: 4_000, width: 1_000, height: 800 });
    renderer.setViewport({ left: 0, top: 5_000, width: 1_000, height: 800 });
    expect(read).not.toHaveBeenCalled();
    scheduler.runAll();
    expect(read).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledOnce();
    expect(writes.mock.calls.length).toBeLessThanOrEqual(2);
    expect(editorWrites).not.toHaveBeenCalled();
    expect(clip.style.getPropertyValue("--inkbook-text-viewport-height")).toBe("800px");
    camera = { x: -20, zoom: 2 };
    renderer.setCamera(camera);
    renderer.setViewport({ left: 0, top: 77_400, width: 1_000, height: 800 });
    scheduler.runAll();
    expect(read).toHaveBeenCalledTimes(4);
    expect(editorWrites).not.toHaveBeenCalled();
    expect(clip.style.getPropertyValue("--inkbook-text-viewport-top")).toBe("38600px");
    expect(clip.style.getPropertyValue("--inkbook-text-viewport-height")).toBe("400px");
    expect(handle.container.style.getPropertyValue("--inkbook-text-editor-height")).toBe("39000px");
    expect(created).not.toHaveBeenCalled();
    handle.dispose();
    renderer.setViewport({ left: 0, top: 0, width: 1_000, height: 800 });
    scheduler.runAll();
    expect(read).toHaveBeenCalledTimes(4);
    expect(additionalRead).not.toHaveBeenCalled();
    expect(
      handle.pageBoundsForClientRect({ left: 0, right: 1, top: 0, bottom: 1 }),
    ).toBeUndefined();
  } finally {
    renderer.destroy();
  }
});

it.each(["immediate", "progressive"] as const)(
  "publishes 3000-line %s previews cooperatively with their selection frame",
  (mode) => {
    const { canonical, store, record, renderer, scheduler, document, content, overlay } =
      largeTextScene();
    const published = vi.fn();
    const editing = renderer.beginTextEditing(canonical.id, { onGeometryChanged: published })!;
    editing.setReady?.();
    editing.setSuspended(true);
    const originalContent = content.nodes[0];
    const created = observeNodeAllocations(document, scheduler);
    const attributes = vi.spyOn(FakeNode.prototype, "setAttribute");
    const stats = renderer.instrumentation();
    const preview = {
      ...canonical,
      height: canonical.height * 2,
      style: { ...canonical.style, fontSize: 20 },
    };
    const setPreview = (element: typeof canonical, version: number) => {
      if (mode === "immediate") renderer.setElementPreviews([element], version);
      else renderer.setProgressiveElementPreviews([element.id], () => element, version);
    };
    try {
      renderer.setSelectionOverlayPath("M0 0L10 10");
      scheduler.runAll();
      setPreview(preview, 1);
      renderer.setSelectionOverlayPath("M0 0L20 20");
      renderer.flushPointerFeedbackFrame(scheduler.time);
      expect(created).not.toHaveBeenCalled();
      expect(content.nodes[0]).toBe(originalContent);
      expect(overlay.getAttribute("d")).toBe("M0 0L10 10");
      scheduler.runFrame();
      expect(created.mock.calls.length).toBeLessThanOrEqual(10);
      expect(content.nodes[0]).toBe(originalContent);
      expect(overlay.getAttribute("d")).toBe("M0 0L10 10");
      const latest = { ...preview, style: { ...preview.style, fontSize: 30 } };
      setPreview(latest, 2);
      renderer.setSelectionOverlayPath("M0 0L30 30");
      let frames = 0;
      while (scheduler.pendingCount > 0) {
        const before = created.mock.calls.length;
        const beforeWrites = attributes.mock.calls.length;
        scheduler.runFrame();
        // Eight admitted units plus two detached root nodes before the first yielding span.
        expect(created.mock.calls.length - before).toBeLessThanOrEqual(10);
        expect(attributes.mock.calls.length - beforeWrites).toBeLessThanOrEqual(10 * 12 + 32);
        if (content.nodes[0] === originalContent)
          expect(overlay.getAttribute("d")).toBe("M0 0L10 10");
        else expect(content.nodes[0]!.nodes[0]!.nodes[0]!.getAttribute("font-size")).toBe("30");
        frames += 1;
        expect(frames).toBeLessThan(2_000);
      }
      expect(frames).toBeGreaterThan(1);
      expect(content.nodes[0]).not.toBe(originalContent);
      const spans = nodes(content).filter((node) => node.tagName === "tspan");
      expect(spans).toHaveLength(3_000);
      expect(spans.every((node) => node.getAttribute("font-size") === "30")).toBe(true);
      expect(overlay.getAttribute("d")).toBe("M0 0L30 30");
      expect(store.records.get(canonical.id)).toBe(record);
      expect(renderer.instrumentation().geometryBuilds).toBe(stats.geometryBuilds);
      expect(published).toHaveBeenCalledExactlyOnceWith(latest);
      renderer.clearElementPreviews();
      renderer.setSelectionOverlayPath("M0 0L10 10");
      renderer.flushPointerFeedbackFrame();
      expect(spans[0]!.getAttribute("font-size")).toBe("30");
      scheduler.runAll(2_000);
      expect(
        nodes(content)
          .find((node) => node.tagName === "tspan")!
          .getAttribute("font-size"),
      ).toBe("10");
      expect(overlay.getAttribute("d")).toBe("M0 0L10 10");
      const restored = content.nodes[0];
      const memory = renderer.memoryUsage();
      setPreview(preview, 3);
      scheduler.runFrame();
      expect(renderer.memoryUsage().pathCacheBytes).toBeGreaterThan(memory.pathCacheBytes);
      renderer.clearElementPreviews();
      scheduler.runAll(2_000);
      expect(content.nodes[0]).toBe(restored);
      expect(renderer.memoryUsage()).toEqual(memory);
      expect(content.textContent).toBe(canonical.source.replaceAll("\n", ""));
    } finally {
      renderer.destroy();
    }
    expect(scheduler.pendingCount).toBe(0);
    expect(renderer.memoryUsage()).toEqual({ motionCacheBytes: 0, pathCacheBytes: 0 });
  },
);

it("keeps a 3000-line commit coherent when it supersedes unfinished preview glyphs", async () => {
  const { renderer, scheduler, document, canonical, content, overlay, store, record } =
    largeTextScene();
  renderer.setSelectionOverlayPath("M0 0L10 10");
  scheduler.runAll();
  const original = content.nodes[0];
  const created = observeNodeAllocations(document, scheduler);
  try {
    renderer.setElementPreviews([{ ...canonical, style: { ...canonical.style, fontSize: 20 } }], 1);
    renderer.setSelectionOverlayPath("M0 0L20 20");
    scheduler.runFrame();
    expect(content.nodes[0]).toBe(original);
    const committed = { ...canonical, style: { ...canonical.style, fontSize: 30 } };
    const next = { ...createSceneRecord(committed), geometryVersion: 2, paintVersion: 2 };
    store.records.set(canonical.id, next);
    renderer.applyDelta({
      affected: [
        {
          id: canonical.id,
          domains: ["geometry", "paint"],
          before: canonical,
          after: committed,
          beforeBounds: record.bounds,
          afterBounds: next.bounds,
        },
      ],
    });
    renderer.clearElementPreviews();
    renderer.setSelectionOverlayPath("M0 0L30 30");
    renderer.flushPointerFeedbackFrame();
    expect(overlay.getAttribute("d")).toBe("M0 0L10 10");
    const ready = renderer.waitForTextElement(canonical.id);
    let frames = 0;
    while (scheduler.pendingCount > 0) {
      const before = created.mock.calls.length;
      scheduler.runFrame();
      expect(created.mock.calls.length - before).toBeLessThanOrEqual(10);
      if (content.nodes[0] === original) expect(overlay.getAttribute("d")).toBe("M0 0L10 10");
      frames += 1;
      expect(frames).toBeLessThan(2_000);
    }
    await ready;
    expect(frames).toBeGreaterThan(1);
    expect(content.nodes[0]!.nodes[0]!.nodes[0]!.getAttribute("font-size")).toBe("30");
    expect(overlay.getAttribute("d")).toBe("M0 0L30 30");
    renderer.setElementPreviews([{ ...committed, style: { ...committed.style, fontSize: 40 } }], 2);
    scheduler.runFrame();
  } finally {
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
  expect(renderer.memoryUsage()).toEqual({ motionCacheBytes: 0, pathCacheBytes: 0 });
});

it("bounds actual native DOM preparation for ten thousand runs and reuses retained geometry", () => {
  const owner = new FakeDocument();
  const document = asDocument(owner);
  const element = textElement({ source: "a".repeat(10_000) });
  element.layout.lines[0]!.runs = Array.from({ length: 10_000 }, (_, index) => ({
    text: "a",
    start: index,
    end: index + 1,
    x: index,
    width: 1,
  }));
  const record = createSceneRecord(element);
  const instrumentation = createInstrumentation();
  const preparation = new SceneTextPreparation({ ownerDocument: document, instrumentation });
  let time = 0;
  const create = owner.createElementNS.bind(owner);
  const created = vi.spyOn(owner, "createElementNS").mockImplementation((...args) => {
    time += 1;
    return create(...args);
  });
  const attributes = vi.spyOn(FakeNode.prototype, "setAttribute");
  let batches = 0;
  let done = false;
  while (!done) {
    const before = created.mock.calls.length;
    const beforeAttributes = attributes.mock.calls.length;
    done = preparation.prepare(record, new MountSlice(time + 16, () => time));
    expect(created.mock.calls.length - before).toBeLessThanOrEqual(16);
    // Twelve canonical tspan attributes plus five fixed text/root/background writes.
    expect(attributes.mock.calls.length - beforeAttributes).toBeLessThanOrEqual(16 * 12 + 5);
    expect(owner.body.nodes).toHaveLength(0);
    batches += 1;
  }
  expect(batches).toBeGreaterThan(1);
  const presentation = preparation.take(element.id)!;
  expect(presentation.content.textContent).toBe(element.source);
  expect(created.mock.calls.filter(([, tag]) => tag === "tspan")).toHaveLength(10_000);
  expect(created).toHaveBeenCalledTimes(10_005);
  expect(attributes).toHaveBeenCalledTimes(120_005);
  const count = created.mock.calls.length;
  const entry = createMountedElement(document, record, [], instrumentation, presentation);
  const constrained = new DetachedSceneElementCache();
  expect(constrained.retain(entry)).toBe(false);
  expect(constrained.memoryUsage()).toBe(0);
  const cache = new DetachedSceneElementCache(8 * 1024 * 1024);
  expect(cache.retain(entry)).toBe(true);
  expect(cache.memoryUsage()).toBeGreaterThan(10_000 * 512);
  expect(cache.take(record, instrumentation)).toBe(entry);
  expect(created.mock.calls.length).toBe(count);
  expect(attributes).toHaveBeenCalledTimes(120_005);
  cache.dispose();
  preparation.cancel();
  expect(preparation.memoryUsage()).toBe(0);
});

it("releases superseded scratch and publishes only the current layout", () => {
  const owner = new FakeDocument();
  const document = asDocument(owner);
  const element = textElement();
  const stats = createInstrumentation();
  const preparation = new SceneTextPreparation({ ownerDocument: document, instrumentation: stats });
  const first = createSceneRecord(element);
  let time = 0;
  const create = owner.createElementNS.bind(owner);
  vi.spyOn(owner, "createElementNS").mockImplementation((...args) => {
    time += 1;
    return create(...args);
  });
  expect(preparation.prepare(first, new MountSlice(1, () => time))).toBe(false);
  expect(preparation.memoryUsage()).toBeGreaterThan(0);
  preparation.cancel(element.id);
  expect(preparation.memoryUsage()).toBe(0);
  const updated = singleLineTextElement("new");
  const next = { ...createSceneRecord(updated), geometryVersion: 2 };
  expect(preparation.prepare(next, new MountSlice(Infinity, () => time))).toBe(true);
  const presentation = preparation.take(element.id)!;
  expect(presentation.content.textContent).toBe("new");
  expect(preparation.memoryUsage()).toBe(0);
});
