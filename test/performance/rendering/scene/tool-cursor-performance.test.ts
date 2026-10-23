import { afterEach, expect, it, vi } from "vitest";

import type { StraightHighlighterElementV1 } from "../../../../src/domain/schema/types";
import { SVG_NAMESPACE } from "../../../../src/rendering/scene/constants";
import { SceneContentRenderer } from "../../../../src/rendering/scene/content-renderer";
import { liveStrokePresentation } from "../../../../src/rendering/scene/content/element-presentation";
import type { SceneToolCursorFrameReader } from "../../../../src/rendering/scene/tool-cursor";
import { FakeNode, fakeNode } from "../../../unit/rendering/scene/fakes";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { INTERACTION_REFRESH_PROFILE } from "../../interaction-refresh-profile";
import {
  createInteractionFixture,
  createInteractionRenderer,
} from "./interaction-refresh-profile-fixture";
import { createCursorFixture, cursorState, observeWork } from "./tool-cursor-fixture";

afterEach(() => vi.restoreAllMocks());

it(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz cursor bursts retain decorations and icons and avoid document work with 10,000 strokes`, () => {
  const { store, renderer, scheduler, root, cursor } = createCursorFixture();
  const before = [...root.nodes];
  const icons = [0, 1].map(() => cursor.ownerDocument.createElementNS(SVG_NAMESPACE, "svg"));
  for (const icon of icons) {
    const nested = cursor.ownerDocument.createElementNS(SVG_NAMESPACE, "svg");
    nested.append(cursor.ownerDocument.createElementNS(SVG_NAMESPACE, "path"));
    icon.append(nested);
  }
  const observations = observeWork(store, root, renderer.inputSurface);
  let position = 0;
  const read = vi.fn<SceneToolCursorFrameReader>(() => ({
    cursor: cursorState(position, icons[0]!),
    system: "crosshair",
  }));
  renderer.resetInstrumentation();
  try {
    // Consecutive input bursts exercise initial mount, retained movement and unchanged input.
    for (const [next, expectedWrites, layoutChanged] of [
      [8, 10, true],
      [16, 1, false],
      [16, 0, false],
    ] as const) {
      observations.write.mockClear();
      observations.traversal.mockClear();
      read.mockClear();
      for (let sample = 0; sample < 8; sample += 1) {
        position = next - 7 + sample;
        renderer.requestToolCursorFrame(read);
      }
      expect(read).not.toHaveBeenCalled();
      expect(observations.write).not.toHaveBeenCalled();
      expect(scheduler.pendingCount).toBe(1);
      scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
      scheduler.runNext();
      expect(scheduler.pendingCount).toBe(0);
      expect(read).toHaveBeenCalledExactlyOnceWith(layoutChanged);
      expect(cursor.attributes.get("transform")).toBe(`translate(${String(next)} 40)`);
      // Ten initial attributes including the surface clip; retained moves change only translation.
      expect(observations.write).toHaveBeenCalledTimes(expectedWrites);
      if (layoutChanged) expect(observations.write).toHaveBeenCalledWith("clip-path", "none");
      expect(observations.traversal).toHaveBeenCalledTimes(layoutChanged ? 3 : 0);
    }
    expect(observations.system).toHaveBeenCalledExactlyOnceWith("cursor", "crosshair");
    expect(renderer.instrumentation()).toMatchObject({
      scheduledFrames: 3,
      geometryBuilds: 0,
      contentGeometryWrites: 0,
      livePreviewUpdates: 0,
    });

    expect(root.nodes).toEqual(before);
    expect(icons[0]!.parent!.nodes).toEqual([icons[0]]);
    expect(observations.append).toHaveBeenCalledExactlyOnceWith(icons[0]);
    expect(observations.insert).toHaveBeenCalledExactlyOnceWith(icons[0], null);
    expect(observations.remove).not.toHaveBeenCalled();
    for (const observation of observations.content) expect(observation).not.toHaveBeenCalled();
    assertStyleUpdates(renderer, scheduler, observations, icons);

    observations.write.mockClear();
    // Replace the persistent reader as an input adapter does when leaving the surface.
    renderer.requestToolCursorFrame(() => ({ cursor: null, system: "default" }));
    scheduler.runNext();
    expect(observations.write).toHaveBeenCalledExactlyOnceWith("display", "none");
    expect(observations.system).toHaveBeenLastCalledWith("cursor", "default");

    const cancelledRead = vi.fn(() => ({
      cursor: cursorState(32, icons[1]!),
      system: "crosshair",
    }));
    renderer.requestToolCursorFrame(cancelledRead);
    expect(scheduler.pendingCount).toBe(1);
    renderer.destroy();
    expect(scheduler.pendingCount).toBe(0);
    expect(cancelledRead).not.toHaveBeenCalled();
    expect(root.parent).toBeUndefined();
  } finally {
    renderer.destroy();
  }
});

it(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz staged marker commits move paths once and retain them through partial mounts`, () => {
  const { store } = createInteractionFixture();
  const { renderer, scheduler } = createInteractionRenderer(store);
  scheduler.runAll();
  const root = fakeNode(renderer.svg);
  const liveGroup = root.nodes[1]!.nodes[5]!;
  const create = vi.spyOn(root.ownerDocument, "createElementNS");
  const append = vi.spyOn(FakeNode.prototype, "append");
  const write = vi.spyOn(FakeNode.prototype, "setAttribute");
  const get = vi.spyOn(store, "get");
  const query = vi.spyOn(store, "beginQuery");
  const mounted = vi.spyOn(SceneContentRenderer.prototype, "hasMounted");
  const retained: FakeNode[] = [];
  const ids: string[] = [];
  try {
    for (const rank of [0, 1]) {
      const marker = markerElement(rank);
      ids.push(marker.id);
      publishMarker(renderer, store, marker);
      const path = liveGroup.nodes[0]!;
      stageMarker(renderer, marker);
      for (const spy of [create, append, write, get, query, mounted]) spy.mockClear();
      renderer.resetInstrumentation();
      renderer.commitLivePath(marker.id);
      retained.push(path.parent!);
      expect(path.parent!.nodes).toEqual([path]);
      expect(path.attributes.get("d")).toBe(`M10 10L${String(marker.end.x)} 10`);
      expect(liveGroup.nodes).toHaveLength(1);
      expect(liveGroup.nodes[0]).not.toBe(path);
      expect(liveGroup.nodes[0]!.attributes.has("d")).toBe(false);
      expect(create.mock.calls.map(([, tag]) => tag)).toEqual(["g", "path"]);
      // Stage/reparent, retain, append replacement, and at most one render-band move.
      expect(append.mock.calls.length).toBeLessThanOrEqual(5);
      // Ten presentation attributes, one geometry write and three pointer-events attributes.
      expect(write.mock.calls.length).toBeLessThanOrEqual(14);
      expect(write.mock.calls.filter(([attribute]) => attribute === "d")).toHaveLength(1);
      expect(get).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(mounted).toHaveBeenCalledTimes(rank + 1);
      expect(renderer.instrumentation().geometryBuilds).toBe(0);
      expect(scheduler.pendingCount).toBe(1);
    }
    const band = retained[0]!.parent!;
    const clock = vi.spyOn(scheduler, "now").mockImplementation(() => {
      scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
      return scheduler.time;
    });
    scheduler.runNext();
    expect(ids.some((id) => renderer.mountedIds("highlight").includes(id))).toBe(false);
    expect(retained.every((group) => group.parent === band)).toBe(true);
    expect(scheduler.pendingCount).toBe(1);
    clock.mockRestore();
    scheduler.runAll();
    expect(renderer.mountedIds("highlight")).toEqual(ids);
    expect(retained.every((group) => group.parent === undefined)).toBe(true);
    // The live host is empty and only the two canonical marker paths paint in this band.
    expect(paintedPaths(band)).toHaveLength(2);

    const abandoned = markerElement(2);
    publishMarker(renderer, store, abandoned);
    stageMarker(renderer, abandoned);
    const abandonedPath = liveGroup.nodes[0]!;
    renderer.commitLivePath(abandoned.id);
    const abandonedGroup = abandonedPath.parent!;
    renderer.destroy();
    expect(abandonedGroup.parent).toBeUndefined();
    expect(root.parent).toBeUndefined();
    expect(scheduler.pendingCount).toBe(0);
  } finally {
    renderer.destroy();
  }
});

function markerElement(rank: number): StraightHighlighterElementV1 {
  const stroke = indexedStroke(20_000 + rank);
  return {
    id: stroke.id,
    createdAt: stroke.createdAt,
    kind: "straight-highlighter",
    rotation: 0,
    pivot: { x: 15 + rank / 2, y: 10 },
    start: { x: 10, y: 10 },
    end: { x: 20 + rank, y: 10 },
    bend: null,
    startNode: "none",
    endNode: "none",
    style: { ...stroke.style, opacity: 0.4, pressureEnabled: false },
  };
}

function paintedPaths(root: FakeNode): FakeNode[] {
  return root.nodes.flatMap((node) =>
    node.tagName === "path" && node.attributes.get("d") ? [node] : paintedPaths(node),
  );
}

function stageMarker(
  renderer: ReturnType<typeof createInteractionRenderer>["renderer"],
  marker: StraightHighlighterElementV1,
): void {
  renderer.setLivePath({
    band: "highlight",
    parts: [
      {
        d: `M10 10L${String(marker.end.x)} 10`,
        presentation: liveStrokePresentation(marker.style, "stroke", "highlighter"),
      },
    ],
  });
}

function publishMarker(
  renderer: ReturnType<typeof createInteractionRenderer>["renderer"],
  store: ReturnType<typeof createInteractionFixture>["store"],
  marker: StraightHighlighterElementV1,
): void {
  const delta = store.create(marker)!;
  renderer.applyDelta({
    affected: delta.changes.map(({ id, domains }) => ({
      after: marker,
      before: null,
      domains,
      id,
    })),
  });
}

function assertStyleUpdates(
  renderer: ReturnType<typeof createInteractionRenderer>["renderer"],
  scheduler: ReturnType<typeof createInteractionRenderer>["scheduler"],
  observations: ReturnType<typeof observeWork>,
  icons: FakeNode[],
): void {
  const holder = icons[0]!.parent!;
  for (const observation of [observations.write, observations.append, observations.insert]) {
    observation.mockClear();
  }
  renderer.requestToolCursorFrame(() => ({
    cursor: { ...cursorState(16, icons[0]!), color: { type: "rgba", value: "#FF0000FF" } },
    system: "crosshair",
  }));
  scheduler.runNext();
  expect(observations.write).toHaveBeenCalledExactlyOnceWith("color", "#FF0000FF");
  expect(holder.nodes).toEqual([icons[0]]);
  expect(observations.append).not.toHaveBeenCalled();
  expect(observations.insert).not.toHaveBeenCalled();
  expect(observations.remove).not.toHaveBeenCalled();
  expect(observations.traversal).not.toHaveBeenCalled();
  renderer.requestToolCursorFrame(() => ({
    cursor: {
      ...cursorState(16, icons[0]!),
      color: { type: "rgba", value: "#FF0000FF" },
      opacity: 0.2,
    },
    system: "crosshair",
  }));
  observations.write.mockClear();
  scheduler.runNext();
  expect(observations.write).toHaveBeenCalledExactlyOnceWith("opacity", "0.2");
  expect(observations.traversal).not.toHaveBeenCalled();
  observations.write.mockClear();
  renderer.requestToolCursorFrame(() => ({
    cursor: {
      ...cursorState(16, icons[1]!),
      opacity: 0.2,
      color: { type: "rgba", value: "#FF0000FF" },
    },
    system: "crosshair",
  }));
  scheduler.runNext();
  // The already-built toolbar icon moves into the retained host exactly once.
  expect(observations.write.mock.calls).toEqual([
    ["width", "18"],
    ["height", "18"],
  ]);
  expect(observations.append).toHaveBeenCalledExactlyOnceWith(icons[1]);
  expect(observations.insert).toHaveBeenCalledExactlyOnceWith(icons[1], null);
  expect(observations.remove).toHaveBeenCalledOnce();
  expect(observations.traversal).toHaveBeenCalledTimes(3);
  expect(icons[0]!.parent).toBeUndefined();
  expect(holder.nodes).toEqual([icons[1]]);
  for (const observation of observations.content) expect(observation).not.toHaveBeenCalled();
  observations.write.mockClear();
  renderer.requestToolCursorFrame(() => ({
    cursor: { kind: "eraser", x: 16, y: 40, radius: 20 },
    system: "crosshair",
  }));
  scheduler.runNext();
  expect(observations.write).toHaveBeenCalledTimes(3);
  expect(observations.append).toHaveBeenCalledOnce();
  expect(observations.remove).toHaveBeenCalledOnce();
  expect(holder.nodes).toEqual([icons[1]]);
}
