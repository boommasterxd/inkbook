import { expect, it, vi } from "vitest";
import type { Bounds } from "../../../../src/domain/geometry/primitives";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { createMountedElement } from "../../../../src/rendering/scene/mounted-element";
import { SceneElementFades } from "../../../../src/rendering/scene/scene-element-fades";
import * as fadeStyle from "../../../../src/rendering/scene/element-fade-style";
import { FakeDocument, fakeNode, fakeRectangleRecord } from "./fakes";
import { FakeSceneStore } from "./fakes";
import {
  createSceneFixture,
  createSceneRecord,
  replaySceneMembership,
} from "../../../fixtures/rendering/scene";
import { createPublicationScene } from "../../../fixtures/rendering/scene-publication";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { arrow } from "../../domain/schema/fixtures";

const VIEWPORT: Bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
const OFFSCREEN: Bounds = { minX: 0, minY: 101, maxX: 100, maxY: 120 };

function setup() {
  const entry = createMountedElement(
    new FakeDocument() as unknown as Document,
    fakeRectangleRecord("membership", 0, 10),
    [{ d: "M0 0L10 10", paint: "stroke" }],
    createInstrumentation(),
  );
  const mounted = new Map([[entry.id, entry]]);
  const readiness = vi.fn();
  const fades = new SceneElementFades(mounted, readiness);
  fades.setViewport(VIEWPORT);
  return { entry, mounted, readiness, fades, node: fakeNode(entry.paths[0]!.node) };
}

it.each(["offscreen", "return", "interrupt"] as const)(
  "retains the first admission across a real filled arrow's two exit slices, %s",
  (retarget) => {
    const document = new FakeDocument();
    const source = arrow();
    const record = createSceneRecord({
      ...source,
      style: { ...source.style, outlineOpacity: 0.35 },
    });
    const entry = createMountedElement(
      document as unknown as Document,
      record,
      buildElementPathParts(record.element),
      createInstrumentation(),
    );
    expect(entry.paths).toHaveLength(2);
    const paths = entry.paths.map((path) => fakeNode(path.node));
    const paint = paths.map((node) => [...node.attributes]);
    const svg = document.createElementNS("", "svg") as unknown as SVGElement;
    const readiness = vi.fn();
    const gate = vi.fn((generation: number, interrupted: boolean) =>
      fadeStyle.setHistoryFadeGate(svg, generation, interrupted),
    );
    const fades = new SceneElementFades(new Map([[entry.id, entry]]), readiness, gate);
    fades.setViewport(record.bounds);
    fades.setMembership(entry.id, "exit", 400, record.bounds);
    expect(fades.flush(0, () => 0)).toBe(true);
    expect(paths[0]!.style.animation).toContain("opacity-exit");
    expect(paths[0]!.style.animation).toContain("--inkbook-history-duration-0, 400ms)");
    expect(paths[1]!.style.getPropertyValue("animation")).toBe("");
    fades.setViewport(VIEWPORT);
    if (retarget === "return") fades.setViewport(record.bounds);
    if (retarget === "interrupt") fades.interruptMembership();
    expect(fades.flush(Infinity, () => 10)).toBe(false);
    if (retarget === "interrupt") {
      expect(fades.isExitReady(entry.id, 10)).toBe(true);
      expect(svg.style.getPropertyValue("--inkbook-history-duration-0")).toBe("0ms");
      expect(paths[1]!.style.opacity).toBe("0");
      expect(gate).toHaveBeenCalledWith(0, true);
    } else {
      expect(paths[1]!.style.animation).toContain("--inkbook-history-duration-0, 400ms)");
      expect(paths[1]!.style.animation).toContain("opacity-exit");
      expect(paths.every((node) => node.style.getPropertyValue("opacity") === "")).toBe(true);
      expect(fades.isExitReady(entry.id, 409)).toBe(false);
      expect(fades.isExitReady(entry.id, 410)).toBe(true);
      expect(readiness).toHaveBeenLastCalledWith(entry.id, 410);
    }
    expect(paths.map((node) => [...node.attributes])).toEqual(paint);
    fades.releaseMounted(entry.id);
    expect(gate).toHaveBeenLastCalledWith(0, false);
    expect(svg.style.getPropertyValue("--inkbook-history-duration-0")).toBe("");
    expect(fades.memoryUsage()).toBe(0);
  },
);

it.each(["enter", "exit"] as const)(
  "admits %s only for overlapping or unproved bounds, including the clip boundary",
  (direction) => {
    const { entry, fades, node, readiness } = setup();
    const write = vi.spyOn(fadeStyle, "setElementFadeNode");
    try {
      fades.setMembership(entry.id, direction, 400, OFFSCREEN);
      expect(fades.flush(Infinity, () => 0)).toBe(false);
      if (direction === "enter") expect(write).not.toHaveBeenCalled();
      else {
        expect(write).toHaveBeenCalledOnce();
        expect(write.mock.calls[0]![1]).toBe(0);
        expect(node.style.opacity).toBe("0");
      }
      expect(node.style.getPropertyValue("animation")).toBe("");
      expect(readiness).toHaveBeenLastCalledWith(entry.id, 0);
      for (const bounds of [VIEWPORT, { ...OFFSCREEN, minY: 100 }, undefined]) {
        fades.setMembership(entry.id, direction, 400, bounds);
        fades.flush(Infinity, () => 10);
        expect(node.style.animation).toContain(`${direction} var(`);
        expect(node.style.animation).toContain("400ms)");
        if (direction === "enter") expect(node.style.animation).toContain("reverse both");
        else {
          expect(fades.isExitReady(entry.id, 409)).toBe(false);
          expect(fades.isExitReady(entry.id, 410)).toBe(true);
        }
        fades.set([entry.id], null);
      }
      fades.release();
      expect(fades.memoryUsage()).toBe(0);
    } finally {
      write.mockRestore();
    }
  },
);

it("rechecks the current clip before a queued exit and before restoration publication", () => {
  const { entry, mounted, readiness, fades, node } = setup();
  const write = vi.spyOn(fadeStyle, "setElementFadeNode");
  try {
    fades.setMembership(entry.id, "exit", 400, VIEWPORT);
    fades.setViewport(OFFSCREEN);
    fades.flush(Infinity, () => 0);
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]![1]).toBe(0);
    expect(node.style.opacity).toBe("0");
    expect(readiness).toHaveBeenLastCalledWith(entry.id, 0);
    expect(fades.isExitReady(entry.id, 0)).toBe(true);
    fades.set([entry.id], null);
    mounted.clear();
    fades.setViewport(VIEWPORT);
    fades.setMembership(entry.id, "enter", 400, VIEWPORT);
    fades.setViewport(OFFSCREEN);
    mounted.set(entry.id, entry);
    fades.bindMounted(entry);
    expect(node.style.getPropertyValue("visibility")).toBe("");
    expect(fades.pending).toBe(false);
    expect(fades.memoryUsage()).toBe(0);
  } finally {
    write.mockRestore();
  }
});

it("cleans an already admitted exit on an offscreen Undo without a replacement animation", () => {
  const { entry, fades, node } = setup();
  fades.setMembership(entry.id, "exit", 400, VIEWPORT);
  fades.flush(Infinity, () => 0);
  fades.setViewport(OFFSCREEN);
  fades.setMembership(entry.id, "enter", 400, VIEWPORT);
  fades.flush(Infinity, () => 10);
  expect(fades.isExitReady(entry.id, 10)).toBe(true);
  expect(node.style.getPropertyValue("animation")).toBe("");
  expect(node.style.getPropertyValue("opacity")).toBe("");
  expect(fades.memoryUsage()).toBe(0);
  fades.setViewport(VIEWPORT);
  fades.setMembership(entry.id, "exit", 400, VIEWPORT);
  fades.flush(Infinity, () => 20);
  expect(node.style.animation).toContain("400ms)");
  expect(fades.isExitReady(entry.id, 419)).toBe(false);
  expect(fades.isExitReady(entry.id, 420)).toBe(true);
  fades.releaseMounted(entry.id);
  expect(fades.memoryUsage()).toBe(0);
});

it.each([false, true])(
  "restores roots concealed before their first entrance, retarget=%s",
  (retarget) => {
    const { entry, mounted, fades, node } = setup();
    mounted.clear();
    fades.setMembership(entry.id, "enter", 400, VIEWPORT);
    mounted.set(entry.id, entry);
    fades.bindMounted(entry);
    expect(node.style.visibility).toContain(", hidden)");
    fades.setViewport(OFFSCREEN);
    if (retarget) fades.setMembership(entry.id, "enter", 400, VIEWPORT);
    fades.flush(Infinity, () => 0);
    expect(node.style.getPropertyValue("animation")).toBe("");
    expect(node.style.getPropertyValue("visibility")).toBe("");
    expect(fades.memoryUsage()).toBe(0);
  },
);

it.each(["preview", "element-preview", "motion", "unmeasured"] as const)(
  "keeps conservative admission for %s visual state and preserves eraser feedback",
  (state) => {
    const { entry, fades, node } = setup();
    if (state === "preview") entry.appliedPreviewTransform = "translate(0 -101)";
    if (state === "element-preview") entry.displayedPathParts = [...entry.pathParts];
    if (state === "motion") entry.motionActive = true;
    if (state === "unmeasured") fades.setViewport(undefined);
    fades.setMembership(entry.id, "exit", 400, OFFSCREEN);
    fades.flush(Infinity, () => 0);
    expect(node.style.animation).toContain("400ms)");
    fades.set([entry.id], null);
    entry.appliedPreviewTransform = null;
    fades.setViewport(VIEWPORT);
    fades.set([entry.id], 400, { deadline: Infinity, now: () => 20 });
    expect(node.style.animation).toContain("opacity-exit 400ms");
    expect(fades.isExitReady(entry.id, 419)).toBe(false);
    expect(fades.isExitReady(entry.id, 420)).toBe(true);
    fades.release();
  },
);

it.each(["scroll", "zoom"] as const)(
  "uses the latest %s context before reconciliation updates retained scene membership",
  (context) => {
    const store = new FakeSceneStore();
    const records = [
      fakeRectangleRecord("inside", 0, 10),
      fakeRectangleRecord(
        "edge",
        1,
        context === "scroll" ? 10 : 70,
        context === "scroll" ? 150 : 10,
      ),
    ];
    for (const record of records) store.records.set(record.id, record);
    const { renderer, scheduler, content } = createPublicationScene(store, {
      height: 100,
      left: 0,
      top: 0,
      width: 100,
    });
    expect(renderer.mountedCount).toBe(2);
    const roots = [...content.nodes];
    const writes = vi.spyOn(fadeStyle, "setElementFadeNode");
    try {
      if (context === "scroll")
        renderer.setViewport({ height: 100, left: 0, top: 120, width: 100 });
      else renderer.setCamera({ x: 0, zoom: 2 });
      replaySceneMembership(renderer, store, records, "exit");
      expect(writes).not.toHaveBeenCalled();
      scheduler.runNext();
      const animated = writes.mock.calls.filter((call) => call[1] === 150);
      expect(animated).toHaveLength(1);
      expect(animated[0]![0]).toBe(roots[context === "scroll" ? 1 : 0]);
      expect(writes.mock.calls.filter((call) => call[1] === 0)).toHaveLength(1);
      scheduler.time = 150;
      scheduler.runAll();
      expect(renderer.mountedCount).toBe(0);
    } finally {
      writes.mockRestore();
      renderer.destroy();
    }
    expect(scheduler.pendingCount).toBe(0);
  },
);

it("admits a full exit when a queued offscreen removal enters the clip before its start", () => {
  const { entry, fades, node } = setup();
  fades.setMembership(entry.id, "exit", 400, OFFSCREEN);
  fades.setViewport(OFFSCREEN);
  fades.flush(Infinity, () => 10);
  expect(node.style.animation).toContain("400ms)");
  expect(node.style.getPropertyValue("opacity")).toBe("");
  expect(fades.isExitReady(entry.id, 409)).toBe(false);
  expect(fades.isExitReady(entry.id, 410)).toBe(true);
  fades.release();
});

it("keeps concealed reserve exits hidden across scroll while bounded physical cleanup continues", () => {
  const store = new FakeSceneStore();
  const records = Array.from({ length: 100 }, (_, rank) =>
    fakeRectangleRecord(`reserve-${rank}`, rank, 10, 1_100),
  );
  for (const record of records) store.records.set(record.id, record);
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, undefined, {
    scrollPreloadMarginPx: 800,
  });
  scheduler.runAll();
  expect(renderer.mountedCount).toBe(100);
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  try {
    replaySceneMembership(renderer, store, records, "exit");
    scheduler.runNext();
    expect(renderer.mountedCount).toBe(36);
    expect(content.nodes.every((node) => node.style.opacity === "0" && !node.style.animation)).toBe(
      true,
    );
    renderer.setViewport({ height: 1_000, left: 0, top: 1_000, width: 2_048 });
    expect(content.nodes.every((node) => node.style.opacity === "0")).toBe(true);
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(0);
  } finally {
    renderer.destroy();
  }
  expect(scheduler.pendingCount).toBe(0);
});
