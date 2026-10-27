import { afterEach, expect, it, vi } from "vitest";
import { SceneContentRenderer } from "../../../../../src/rendering/scene/content-renderer";
import {
  createProgressivePreviewFixture,
  createLongPreviewStroke,
  observePressurePreviewSteps,
} from "../../../../fixtures/rendering/progressive-element-preview";
import { ProgressivePreviewPath } from "../../../../../src/rendering/scene/content/progressive-preview-path";
import { takeImmutableElementOwnership } from "../../../../../src/domain/store/records/immutability";
import * as elementPath from "../../../../../src/domain/geometry/element-path";
import { fakeNode } from "../../../../unit/rendering/scene/fakes";

import {
  connectedPreviewLine,
  connectedPreviewElements,
  connectedPreviewMap,
  createConnectedPreviewScene,
  expectReleasedPreviewScene,
  observePreviewIds,
} from "../../../../fixtures/rendering/connected-preview-work";

afterEach(() => vi.restoreAllMocks());

it("finishes one cohort while real camera and viewport updates retain the same mounted membership", () => {
  const elements = connectedPreviewElements(1_000);
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  const { renderer, scheduler, store } = createConnectedPreviewScene(elements, viewport);
  renderer.resetInstrumentation();
  let mountedVisits = 0;
  const source = observePreviewIds(
    elements.map(({ id }) => id),
    scheduler,
  );
  const ids = source.ids;
  const original = Reflect.get<SceneContentRenderer, "previewMountedIds">(
    SceneContentRenderer.prototype,
    "previewMountedIds",
  );
  vi.spyOn(SceneContentRenderer.prototype, "previewMountedIds").mockImplementation(function* (
    this: SceneContentRenderer,
    context,
  ) {
    for (const id of original.call(this, context)) {
      mountedVisits += 1;
      scheduler.time += 1;
      yield id;
    }
  });
  const materialize = vi.fn((id: string) => {
    scheduler.time += 1;
    const element = store.records.get(id)!.element;
    return { ...element, end: { x: 35, y: 30 } };
  });
  try {
    renderer.setProgressiveElementPreviews(ids, materialize, 1, undefined, "connected");
    for (let update = 1; update <= 350; update += 1) {
      const offset = (update % 2) / 100;
      renderer.setCamera({ x: offset, zoom: 1 });
      renderer.setViewport({ ...viewport, left: offset });
      scheduler.runNext();
    }
    expect(source.work.visits).toBe(1_000);
    expect(mountedVisits).toBe(1_000);
    expect(materialize.mock.calls.length).toBeGreaterThan(0);
    expect(renderer.instrumentation().contentGeometryWrites).toBeGreaterThan(0);
    scheduler.runAll(1_000);
    expect(materialize).toHaveBeenCalledTimes(1_000);
    expect(source.work.visits).toBe(1_000);
    expect(mountedVisits).toBe(1_000);
    renderer.clearProgressiveElementPreviews();
    scheduler.runAll();
  } finally {
    renderer.destroy();
  }
  expectReleasedPreviewScene(renderer, scheduler);
});

it("finishes membership once and visits every follower during continuous retargeting", () => {
  const { preview, content } = createProgressivePreviewFixture();
  const elements = connectedPreviewMap(300);
  const ids = [...elements.keys()];
  let time = 0;
  let version = 0;
  content.promoteVisible.mockImplementation(() => {
    time += 1;
  });
  const materialize = vi.fn((id: string) => {
    time += 1;
    return { ...elements.get(id)!, end: { x: 30 + version, y: 30 } };
  });
  try {
    for (version = 1; version <= 100; version += 1) {
      preview.set({ ids, materialize, version, connected: true });
      const reads = materialize.mock.calls.length;
      preview.write(time + 8, () => time);
      expect(materialize.mock.calls.length - reads).toBeLessThanOrEqual(8);
    }
    expect(content.promoteVisible).toHaveBeenCalledTimes(300);
    expect(
      new Set(content.applyCanonicalElementPreview.mock.calls.map(([element]) => element.id)).size,
    ).toBe(300);
  } finally {
    preview.clear();
  }
  expect(preview.memoryUsage()).toBe(0);
});

it("bounds unavailable follower probes and resumes a later current generation", () => {
  const { preview, content } = createProgressivePreviewFixture(0);
  const elements = connectedPreviewMap(10_000);
  const ids = [...elements.keys()];
  let time = 0;
  const unavailable = vi.fn(() => {
    time += 1;
    return undefined;
  });
  try {
    preview.set({ ids, materialize: unavailable, version: 1, connected: true });
    expect(preview.write(8, () => time)).toBe(true);
    expect(unavailable).toHaveBeenCalledTimes(8);
    const current = vi.fn((id: string) => elements.get(id));
    preview.set({
      ids,
      materialize: current,
      version: 2,
      connected: true,
      isImmediate: () => true,
    });
    preview.write(time + 8, () => time);
    expect(current).toHaveBeenCalledTimes(10_000);
    expect(content.applyCanonicalElementPreview).toHaveBeenCalledTimes(10_000);
    expect(preview.pending).toBe(false);
    expect(preview.memoryUsage()).toBe(10_000 * 280);
    const build = vi.spyOn(elementPath, "buildElementPathParts");
    preview.applyMounted([ids[0]!]);
    expect(build).toHaveBeenCalledExactlyOnceWith(elements.get(ids[0]!));
    preview.clear();
    build.mockClear();
    preview.applyMounted([ids[0]!]);
    expect(build).not.toHaveBeenCalled();
  } finally {
    preview.clear();
  }
  expect(preview.memoryUsage()).toBe(0);
});

it("retains selected pressure preparation while connected requests retarget", () => {
  const { preview } = createProgressivePreviewFixture();
  const element = createLongPreviewStroke(0);
  takeImmutableElementOwnership(element);
  const materialize = vi.fn(() => element);
  const ids = [element.id];
  const observed = observePressurePreviewSteps();
  const cancel = vi.spyOn(ProgressivePreviewPath.prototype, "cancel");
  try {
    for (const version of [1, 2, 3, 4]) {
      preview.set({
        ids,
        materialize,
        version,
        feedbackIds: ids,
        feedback: {
          transform: `scale(${version + 1} 1)`,
          inverse: `scale(${1 / (version + 1)} 1)`,
        },
      });
      observed.writeNext(preview);
    }
    expect(new Set(observed.steps.mock.contexts).size).toBe(1);
    expect(observed.steps).toHaveBeenCalledTimes(4);
    expect(cancel).not.toHaveBeenCalled();
    preview.clear();
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    preview.release();
  }
  expect(preview.memoryUsage()).toBe(0);
});

it("materializes small connected cohorts only after mounting and releases departed followers", () => {
  const first = connectedPreviewLine(0);
  const last = {
    ...connectedPreviewLine(1),
    start: { x: 20, y: 10_000 },
    end: { x: 30, y: 10_010 },
  };
  const viewport = { height: 100, left: 0, top: 0, width: 100 };
  const { renderer, scheduler, store } = createConnectedPreviewScene([first, last], viewport);
  const materialize = vi.fn((id: string) => store.records.get(id)?.element);
  try {
    renderer.setProgressiveElementPreviews(
      [first.id, last.id],
      materialize,
      1,
      undefined,
      "connected",
    );
    scheduler.runAll();
    expect(materialize).toHaveBeenCalledExactlyOnceWith(first.id);
    materialize.mockClear();
    renderer.setViewport({ ...viewport, top: 10_000 });
    scheduler.runAll();
    expect(materialize).toHaveBeenCalledExactlyOnceWith(last.id);
    renderer.clearProgressiveElementPreviews();
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(1);
    expect(renderer.mountedIds("content")).toEqual([last.id]);
  } finally {
    renderer.destroy();
  }
  expectReleasedPreviewScene(renderer, scheduler);
});

it("retains the latest deferred followers through pointer release and canonical commit", () => {
  const elements = connectedPreviewElements(300);
  const { renderer, scheduler, store } = createConnectedPreviewScene(elements);
  const ids = elements.map(({ id }) => id);
  const replacements = new Map(
    elements.map((element) => [element.id, { ...element, end: { x: 35, y: 30 } }]),
  );
  const materialize = vi.fn((id: string) => {
    scheduler.time += 1;
    return replacements.get(id);
  });
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  try {
    renderer.setProgressiveElementPreviews(ids, materialize, 1, undefined, "connected");
    renderer.flushPointerFeedbackFrame(scheduler.time);
    expect(materialize).not.toHaveBeenCalled();
    const handoff = renderer.beginPreviewCommit();
    expect(handoff.arm(ids)).toBe(true);
    renderer.clearElementPreviews();
    scheduler.runAll();
    expect(materialize).toHaveBeenCalledTimes(300);
    expect(content.nodes.every((node) => node.attributes.get("d") === "M20 20L35 30")).toBe(true);
    for (const id of ids)
      store.records.set(id, {
        ...store.records.get(id)!,
        element: replacements.get(id)!,
        geometryVersion: 2,
      });
    renderer.applyDelta({
      affected: elements.map((before) => ({
        id: before.id,
        before,
        after: replacements.get(before.id)!,
        domains: ["geometry"],
      })),
    });
    scheduler.runAll();
    expect(content.nodes.every((node) => node.attributes.get("d") === "M20 20L35 30")).toBe(true);
    expect(content.nodes.every((node) => !node.attributes.has("transform"))).toBe(true);
    expect(materialize).toHaveBeenCalledTimes(300);
  } finally {
    renderer.destroy();
  }
  expectReleasedPreviewScene(renderer, scheduler);
});

it("updates all 10000 mounted followers with shared deadlines and constant work on reused input", () => {
  const elements = connectedPreviewElements(10_000);
  const { renderer, scheduler, store } = createConnectedPreviewScene(elements);
  const source = observePreviewIds(
    elements.map(({ id }) => id),
    scheduler,
  );
  const ids = source.ids;
  let version = 1;
  const materialize = vi.fn((id: string) => {
    scheduler.time += 1;
    const element = store.records.get(id)!.element;
    if (element.kind !== "line") throw new TypeError("Expected a line.");
    return { ...element, end: { x: 30 + version, y: 30 } };
  });
  const get = vi.spyOn(store, "get");
  const mounted = vi.spyOn(SceneContentRenderer.prototype, "previewMountedIds");
  const apply = vi.spyOn(SceneContentRenderer.prototype, "applyCanonicalElementPreview");
  try {
    renderer.setProgressiveElementPreviews(ids, materialize, version, undefined, "connected");
    renderer.flushPointerFeedbackFrame();
    expect(materialize).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(source.work.visits).toBe(0);
    scheduler.runNext();
    expect(source.work.visits).toBeGreaterThan(0);
    expect(source.work.visits).toBeLessThanOrEqual(scheduler.workScheduler.budgetMs());
    expect(materialize).not.toHaveBeenCalled();
    materialize.mockClear();
    get.mockClear();
    mounted.mockClear();
    apply.mockClear();
    version = 2;
    const visitsBeforeInput = source.work.visits;
    renderer.setProgressiveElementPreviews(ids, materialize, version, undefined, "connected");
    renderer.flushPointerFeedbackFrame();
    expect(materialize).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(mounted).not.toHaveBeenCalled();
    expect(source.work.visits).toBe(visitsBeforeInput);
    scheduler.runAll(3_000);
    expect(materialize).toHaveBeenCalledTimes(10_000);
    expect(apply).toHaveBeenCalledTimes(10_000);
    expect(
      apply.mock.calls.every(([element]) => element.kind === "line" && element.end.x === 32),
    ).toBe(true);
    renderer.clearProgressiveElementPreviews();
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(10_000);
  } finally {
    renderer.destroy();
  }
  expectReleasedPreviewScene(renderer, scheduler);
});
