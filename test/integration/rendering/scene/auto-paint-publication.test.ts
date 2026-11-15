import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SceneAutoPaint } from "../../../../src/rendering/scene/scene-auto-paint";
import { writeAutoPaintBounds } from "../../../../src/rendering/scene/content/auto-paint-bounds";
import { SceneLiveStrokeRenderer } from "../../../../src/rendering/scene/content/live-stroke-renderer";
import { createMountedElement } from "../../../../src/rendering/scene/content/mounted-element";
import { SceneVisibilityCoordinator } from "../../../../src/rendering/scene/scene-visibility-coordinator";
import { SCENE_SURFACE_STYLES } from "../../../../src/rendering/scene/scene-surface-styles";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import type { SceneContentRenderer } from "../../../../src/rendering/scene/content-renderer";
import type { SceneVisibilityState } from "../../../../src/rendering/scene/visibility/visibility-state";
import type { SceneResourcePolicy } from "../../../../src/rendering/scene/scene-resource-policy";
import type { SceneTransformPreviewController } from "../../../../src/rendering/scene/presentation/transform-preview-controller";
import type { SceneElementPreviews } from "../../../../src/rendering/scene/presentation/scene-element-previews";
import type { SceneLivePathCommits } from "../../../../src/rendering/scene/content/live-path-commits";
import type { SceneMotionController } from "../../../../src/rendering/scene/presentation/scene-motion-controller";
import type { SceneElementRecord } from "../../../../src/rendering/scene/types";

const windows: Window[] = [];
afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});
function fixture() {
  const window = new Window();
  windows.push(window);
  const document = window.document as unknown as Document;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const create = (name: "g" | "path" | "defs") => document.createElementNS(svg.namespaceURI, name);
  const root = create("g") as SVGGElement;
  const images = create("g") as SVGGElement;
  const page = create("path") as SVGPathElement;
  const defs = create("defs") as SVGDefsElement;
  root.append(page, images);
  svg.append(root, defs);
  document.body.append(svg);
  const manager = new SceneAutoPaint({
    root,
    images,
    page,
    defs,
    observer: window.MutationObserver as unknown as typeof MutationObserver,
    hasImages: () => true,
    invalidate: () => undefined,
  });
  const flush = (deadline = Infinity) =>
    manager.flush(
      { left: 0, top: 0, width: 800, height: 400 },
      { x: 0, zoom: 1 },
      deadline,
      () => 0,
    );
  const mount = () => {
    const path = create("path") as SVGPathElement;
    path.setAttribute("class", "inkbook-theme-stroke");
    path.setAttribute("d", "M10 10H50");
    writeAutoPaintBounds(path, { minX: 8, minY: 8, maxX: 52, maxY: 12 });
    root.append(path);
    return path;
  };
  return {
    root,
    defs,
    manager,
    flush,
    mount,
    create,
    window: window as unknown as NonNullable<Document["defaultView"]>,
  };
}

function liveHandoffFixture() {
  const f = fixture();
  f.flush();
  const style = f.root.ownerDocument.createElement("style");
  style.textContent = SCENE_SURFACE_STYLES;
  f.root.ownerDocument.head.append(style);
  const host = f.create("g") as SVGGElement;
  f.root.append(host);
  const instrumentation = createInstrumentation();
  const stroke = indexedStroke(1);
  stroke.style = { ...stroke.style, opacity: 0.5 };
  const bounds = { minX: 0, minY: 0, maxX: 40, maxY: 10 };
  const parts = [
    { d: "M0 0H20V10H0Z", paint: "fill" as const },
    { d: "M20 0H40V10H20Z", paint: "fill" as const },
  ];
  const live = new SceneLiveStrokeRenderer(
    f.root.ownerDocument,
    host,
    () => undefined,
    instrumentation,
    f.manager,
  );
  live.update(
    { finalizedChunks: [], tail: { geometry: [{ d: "M0 0H40V10H0Z", paint: "fill" }], bounds } },
    stroke.style,
    "pen",
  );
  const exact = host.firstElementChild!;
  live.commit(stroke.id, () => f.root);
  const record: SceneElementRecord = {
    id: stroke.id,
    element: stroke,
    bounds,
    band: "content",
    rank: 0,
    geometryVersion: 1,
    paintVersion: 1,
  };
  const entry = createMountedElement(f.root.ownerDocument, record, parts, instrumentation);
  f.root.append(entry.group!);
  const content = {
    hasMounted: () => true,
    paintReady: () => f.manager.ready(entry),
    takeCommittedPreviewIds: () => [],
    takeNewlyMountedIds: () => [],
  } as unknown as SceneContentRenderer;
  const coordinator = new SceneVisibilityCoordinator(
    content,
    { contains: () => true } as unknown as SceneVisibilityState,
    {} as SceneResourcePolicy,
    { applyMounted: () => undefined } as unknown as SceneTransformPreviewController,
    { applyMounted: () => undefined } as unknown as SceneElementPreviews,
  );
  const motion = {
    bindMountedEntrances: () => undefined,
    finishEntranceBatch: () => undefined,
  } as unknown as SceneMotionController;
  const finish = () =>
    coordinator.finishMountedFrame(
      live,
      { settle: () => undefined } as unknown as SceneLivePathCommits,
      motion,
      0,
      () => {
        f.flush(0);
      },
    );
  return { f, entry, exact, live, finish };
}

describe("exact live Auto handoff", () => {
  it("keeps one half-opacity owner until every canonical pressure part can paint, despite an exhausted deadline", () => {
    const { f, entry, exact, live, finish } = liveHandoffFixture();
    finish();
    expect(exact.parentNode).not.toBeNull();
    expect(f.window.getComputedStyle(entry.group!).visibility).toBe("hidden");
    f.manager.publishLive(entry.paths[0]!.node);
    finish();
    expect(exact.parentNode).not.toBeNull();
    expect(f.window.getComputedStyle(entry.group!).visibility).toBe("hidden");
    expect(exact.getAttribute("opacity")).toBe("0.5");
    f.manager.publishLive(entry.paths[1]!.node);
    expect(f.flush(0)).toBe(true);
    finish();
    expect(exact.parentNode).toBeNull();
    expect(f.window.getComputedStyle(entry.group!).visibility).not.toBe("hidden");
    expect(entry.group!.getAttribute("opacity")).toBe("0.5");
    live.dispose();
    f.manager.release();
  });
});

describe("native mutation-driven Auto publication", () => {
  it("publishes new atoms, releases fixed paints and restores translated Auto without a geometry rebuild", () => {
    const f = fixture();
    f.flush();
    const path = f.mount();
    path.setAttribute("transform", "translate(20 0)");
    f.flush();
    const initial = path.style.getPropertyValue("--inkbook-auto-paint");
    expect(initial).toMatch(/^url\(#/);
    path.setAttribute("class", "");
    f.flush();
    expect(path.style.getPropertyValue("--inkbook-auto-paint")).toBe("");
    path.setAttribute("class", "inkbook-theme-stroke");
    f.flush();
    const restored = path.style.getPropertyValue("--inkbook-auto-paint");
    expect(restored).not.toBe(initial);
    const id = restored.slice(5, -1);
    expect(f.defs.querySelector(`[id="${id}"]`)?.getAttribute("patternTransform")).toBe(
      "matrix(1 0 0 1 -20 0)",
    );
    path.remove();
    f.flush();
    expect(f.defs.querySelector(`[id="${id}"]`)).toBeNull();
    f.manager.release();
  });

  it("resumes run paint preparation and binds local atoms before the run handoff", () => {
    const f = fixture();
    const path = f.mount();
    f.flush();
    const run = f.create("g") as SVGGElement;
    run.setAttribute("data-inkbook-auto-scope", "");
    f.root.append(run);
    run.append(path);
    let clock = 0;
    expect(f.manager.prepareRun([path], 1, () => clock++)).toBe(false);
    expect(f.manager.prepareRun([path], Infinity, () => 0)).toBe(true);
    f.flush();
    const paint = path.style.getPropertyValue("--inkbook-auto-paint").slice(5, -1);
    const alias = f.defs.querySelector(`[id="${paint}"]`)!;
    const base = f.defs.querySelector(alias.getAttribute("href")!)!;
    const source = base.querySelector("use")!;
    const href = source.getAttribute("href")!;
    run.setAttribute("transform", "translate(50 0)");
    f.flush();
    expect(source.getAttribute("href")).toBe(href);
    expect(alias.getAttribute("patternTransform")).toBe("matrix(1 0 0 1 0 0)");
    expect(f.defs.querySelector(`${href} use`)?.getAttribute("transform")).toBe(
      "matrix(1 0 0 1 -50 0)",
    );
    f.manager.release();
  });

  it("shares source tiles across translated and rotated tight aliases, then releases the last lease", () => {
    const f = fixture();
    const a = f.mount();
    const b = f.mount();
    writeAutoPaintBounds(a, { minX: 0, minY: 0, maxX: 8, maxY: 3 });
    writeAutoPaintBounds(b, { minX: 0, minY: 0, maxX: 8, maxY: 3 });
    a.setAttribute("transform", "translate(10 10)");
    b.setAttribute("transform", "translate(20 10) rotate(90)");
    f.flush();
    const alias = (node: SVGElement) =>
      f.defs.querySelector(
        node.style.getPropertyValue("--inkbook-auto-paint").slice(5, -1).replace(/^/, "#"),
      )!;
    const first = alias(a);
    const second = alias(b);
    const baseId = first.getAttribute("href")!;
    expect(second.getAttribute("href")).toBe(baseId);
    expect(first.childElementCount).toBe(0);
    expect(second.childElementCount).toBe(0);
    expect(first.getAttribute("viewBox")).toBe("10 10 8 3");
    expect(second.getAttribute("viewBox")).toBe("17 10 3 8");
    expect(first.getAttribute("patternTransform")).toBe("matrix(1 0 0 1 -10 -10)");
    const inverse = second.getAttribute("patternTransform")!.slice(7, -1).split(" ").map(Number);
    for (const [index, expected] of [0, -1, 1, 0, -10, 20].entries())
      expect(inverse[index]).toBeCloseTo(expected);
    a.setAttribute("transform", "translate(100 10)");
    f.flush();
    const replacement = first.getAttribute("href")!;
    expect(replacement).not.toBe(baseId);
    expect(f.defs.querySelector(baseId)).not.toBeNull();
    a.remove();
    f.flush();
    expect(f.defs.querySelector(replacement)).toBeNull();
    expect(f.defs.querySelector(baseId)).not.toBeNull();
    b.remove();
    f.flush();
    expect(f.defs.querySelector(baseId)).toBeNull();
    f.manager.release();
    expect(f.defs.childElementCount).toBe(0);
  });
});
