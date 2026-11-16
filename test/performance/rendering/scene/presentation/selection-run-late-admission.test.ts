import { afterEach, expect, it, vi } from "vitest";
import { scaleElement } from "../../../../../src/editor/selection/transform/transforms";
import * as mounted from "../../../../../src/rendering/scene/content/mounted-element";
import { sceneDeltaEntries } from "../../../../fixtures/rendering/scene";
import {
  contentPaths,
  fixture,
  fixtureElement,
  moveFeedback,
  observeSelectionInsertions,
  paintedX,
  publishSelectionMove,
} from "../../../../fixtures/rendering/selection-runs";
import {
  FakeNode,
  fakeNode,
  sceneBandNode,
  sceneNodeWithClass,
} from "../../../../unit/rendering/scene/fakes";
import { INTERACTION_REFRESH_PROFILE } from "../../../interaction-refresh-profile";

afterEach(() => vi.restoreAllMocks());

it("drains a cancelled legacy basis before a continuous move of a changed selection", () => {
  const f = fixture(
    600,
    false,
    false,
    [],
    INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs,
  );
  try {
    const svg = fakeNode(f.renderer.svg),
      paths = contentPaths(svg);
    const path = paths[paths.length - 1]!,
      oldOnly = paths[0]!;
    const band = sceneBandNode(svg, "content"),
      before = paintedX(path, band);
    const oldBefore = paintedX(oldOnly, band);
    f.renderer.setSelectedElements(f.selection);
    publishSelectionMove(f, { x: 15, y: 10 });
    f.scheduler.runAll();
    expect(svg.getAttribute("data-inkbook-run-feedback")).toBe("true");
    f.renderer.clearPreviewTransforms();
    expect(svg.getAttribute("data-inkbook-run-feedback")).toBe("true");
    f.renderer.setSelectedElements(new Set());
    const ids = f.elements
      .filter((element) => element.kind === "rectangle")
      .map((element) => element.id);
    const selection = new Set(ids);
    f.renderer.setSelectedElements(selection);
    // Actual writes consume the shared slice; geometry must get a fresh admitted slice.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded with its DOM receiver.
    const setAttribute = FakeNode.prototype.setAttribute;
    const writes = vi.spyOn(FakeNode.prototype, "setAttribute").mockImplementation(function (
      this: FakeNode,
      name,
      value,
    ) {
      setAttribute.call(this, name, value);
      f.scheduler.time += INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs / 32;
    });
    const members = new Set(paths);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded with its DOM receiver.
    const insertBefore = FakeNode.prototype.insertBefore;
    let publications = 0;
    const insertions = vi.spyOn(FakeNode.prototype, "insertBefore").mockImplementation(function (
      this: FakeNode,
      node,
      reference,
    ) {
      const count = (node.fragment ? node.nodes : [node]).filter((member) =>
        members.has(member),
      ).length;
      const result = insertBefore.call(this, node, reference);
      if (count !== 0 && this.parent === band) {
        publications += count;
        f.scheduler.time += (count * INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs) / 4;
      }
      return result;
    });
    let version = 0;
    do {
      version += 1;
      f.scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
      f.renderer.setPreviewTransform(
        ids,
        `translate(${version} 10)`,
        version,
        "scale",
        undefined,
        moveFeedback(selection, version, 10),
      );
      f.scheduler.runFrame();
      expect(paintedX(path, band)).toBeCloseTo(before + version, 6);
      expect(paintedX(oldOnly, band)).toBeCloseTo(oldBefore, 6);
      if (version === 1) expect(publications).toBeGreaterThan(1);
      writes.mockClear();
      insertions.mockClear();
    } while (svg.getAttribute("data-inkbook-run-ready") !== "true" && version < 2000);
    expect(svg.getAttribute("data-inkbook-run-feedback")).toBe("true");
    f.renderer.clearPreviewTransforms();
    f.scheduler.runAll(2000);
    expect(paintedX(path, band)).toBeCloseTo(before, 6);
    expect(paintedX(oldOnly, band)).toBeCloseTo(oldBefore, 6);
  } finally {
    f.renderer.destroy();
    f.port.release();
  }
});

it("advances trace-first admission from input flushes before any deferred scene frame", () => {
  const f = fixture(
    600,
    false,
    false,
    [],
    INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs,
  );
  try {
    const svg = fakeNode(f.renderer.svg);
    const paths = contentPaths(svg),
      path = paths[paths.length - 1]!;
    const band = sceneBandNode(svg, "content");
    const before = paintedX(path, band);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded with the observed DOM receiver.
    const setAttribute = FakeNode.prototype.setAttribute;
    let memberTransforms = 0;
    vi.spyOn(FakeNode.prototype, "setAttribute").mockImplementation(function (
      this: FakeNode,
      name,
      value,
    ) {
      setAttribute.call(this, name, value);
      if (name === "transform" && this.tagName === "path") memberTransforms += 1;
      f.scheduler.time += INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs / 256;
    });
    f.renderer.setSelectedElements(f.selection);
    f.renderer.resetInstrumentation();
    let version = 0;
    while (svg.getAttribute("data-inkbook-run-feedback") !== "true" && version < 1000) {
      version += 1;
      f.scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
      f.scheduler.workScheduler.requestFrame(() => {
        f.renderer.setPreviewTransform(
          f.ids,
          `translate(${version} 10)`,
          version,
          "scale",
          undefined,
          moveFeedback(f.selection, version, 10),
        );
        f.renderer.flushPointerFeedbackFrame();
        expect(f.renderer.instrumentation().frames).toBe(0);
        if (version === 1)
          expect(f.renderer.instrumentation().selectionTraceNodesCreated).toBeGreaterThan(0);
      }, "input");
      f.scheduler.runFrame();
      expect(paintedX(path, band)).toBeCloseTo(before + version, 6);
      const traces = sceneNodeWithClass(svg, "inkbook-selection-traces");
      const visit = (node: FakeNode): FakeNode | undefined =>
        node.getAttribute("data-selection-element-id") === f.ids[f.ids.length - 1]
          ? node
          : node.nodes.map(visit).find((child) => child !== undefined);
      const trace = visit(traces);
      if (trace !== undefined) expect(paintedX(trace, traces)).toBeCloseTo(before + version, 6);
    }
    expect(svg.getAttribute("data-inkbook-run-feedback")).toBe("true");
    memberTransforms = 0;
    f.renderer.setPreviewTransform(
      f.ids,
      "translate(2000 10)",
      1001,
      "scale",
      undefined,
      moveFeedback(f.selection, 2000, 10),
    );
    f.scheduler.runFrame();
    expect(paintedX(path, band)).toBeCloseTo(before + 2000, 6);
    // Only the two existing pressure exceptions stay on individual feedback.
    expect(memberTransforms).toBeLessThanOrEqual(4);
    f.renderer.clearPreviewTransforms();
    expect(paintedX(path, band)).toBeCloseTo(before, 6);
    f.scheduler.runAll(2000);
    expect(paintedX(path, band)).toBeCloseTo(before, 6);
  } finally {
    f.renderer.destroy();
    f.port.release();
  }
});

it("preserves one ordinary geometry admission when camera publication consumes the shared frame", () => {
  const f = fixture(1, false, true, [], INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs);
  try {
    const root = fakeNode(f.renderer.svg).nodes[1]!;
    const setAttribute = root.setAttribute.bind(root);
    const cameraWrites: string[] = [];
    vi.spyOn(root, "setAttribute").mockImplementation((name, value) => {
      setAttribute(name, value);
      if (name === "transform") {
        cameraWrites.push(value);
        f.scheduler.time += f.scheduler.workScheduler.budgetMs();
      }
    });
    const target = f.selected[f.selected.length - 1]!;
    const replacement = scaleElement(target, { x: 0, y: 0 }, { x: 2, y: 1 });
    const geometry = vi.spyOn(mounted, "updateMountedGeometry");
    f.renderer.suppressMotionForNextDelta([target.id]);
    f.renderer.applyDelta({
      affected: sceneDeltaEntries(f.store.replaceMany([replacement])!),
    });
    f.renderer.setCamera({ x: 0, zoom: 2 });
    f.scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
    f.scheduler.runFrame();
    expect(cameraWrites.length).toBe(1);
    expect(geometry.mock.calls.filter(([entry]) => entry.id === target.id).length).toBe(1);
    f.scheduler.runAll();
  } finally {
    f.renderer.destroy();
    f.port.release();
  }
});

it("retains the coalesced preparation successor when the last paint publication exhausts the frame", () => {
  const f = fixture(600, false, true, [], INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs);
  try {
    f.renderer.setReducedMotion(true);
    f.scheduler.runAll();
    const svg = fakeNode(f.renderer.svg);
    expect(svg.getAttribute("data-inkbook-run-ready")).toBe("true");
    const paths = contentPaths(svg);
    const memberInsertions = observeSelectionInsertions(new Set(paths));
    const updatePaint = mounted.updateMountedPaint;
    const paint = vi.spyOn(mounted, "updateMountedPaint").mockImplementation((...args) => {
      updatePaint(...args);
      f.scheduler.time += f.scheduler.workScheduler.budgetMs();
    });
    const target = f.selected[f.selected.length - 1]!;
    if (target.kind !== "rectangle") throw new Error("Expected the fixture's last rectangle.");
    const delta = f.store.updateStyle(target.id, {
      ...target.style,
      outlineColor: { type: "rgba" as const, value: "#000000FF" as const },
    })!;
    expect(delta.changes[0]!.domains).toEqual(["paint"]);
    f.renderer.applyDelta({ affected: sceneDeltaEntries(delta) });
    f.scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
    f.scheduler.runFrame();
    expect(paint.mock.calls.length).toBe(1);
    expect(memberInsertions).toHaveLength(0);
    expect(svg.getAttribute("data-inkbook-run-ready")).toBeNull();
    expect(f.scheduler.pendingCount).toBe(1);
    f.scheduler.runAll(1000);
    expect(
      svg.getAttribute("data-inkbook-run-ready"),
      JSON.stringify({
        fallback: svg.getAttribute("data-inkbook-run-fallback"),
        pending: f.scheduler.pendingCount,
        mounted: f.renderer.mountedCount,
      }),
    ).toBe("true");
    expect(f.scheduler.pendingCount).toBe(0);
    const values = new Map(
      f.ids.map((id) => [id, scaleElement(fixtureElement(f, id), { x: 0, y: 0 }, { x: 2, y: 1 })]),
    );
    const shape = paths[paths.length - 1]!;
    const band = svg.nodes[1]!.nodes[5]!;
    const before = paintedX(shape, band);
    f.renderer.setProgressiveElementPreviews(f.ids, (id) => values.get(id), 1, f.feedback);
    f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
    expect(paintedX(shape, band)).toBeCloseTo(before * 2, 6);
  } finally {
    f.renderer.destroy();
    f.port.release();
  }
});
