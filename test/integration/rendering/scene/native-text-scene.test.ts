// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { SvgSceneRenderer } from "../../../../src/rendering/scene/scene-renderer";
import { singleLineTextElement, textElement } from "../../../fixtures/rendering/text";
import { createSceneRecord } from "../../../fixtures/rendering/scene";
import {
  FakeSceneStore,
  FakeScheduler,
  fakeRectangleRecord,
} from "../../../unit/rendering/scene/fakes";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { createWorkerSnapshot } from "../../../fixtures/persistence/worker-snapshot";
import { scaleElement } from "../../../../src/editor/selection/transform/transforms";
import {
  textPreviewMatrix,
  textRectBounds,
} from "../../../../src/rendering/scene/text-editing-geometry";
import type { AffineMatrix } from "../../../../src/domain/geometry/affine-matrix";
import { calculateElementBounds } from "../../../../src/domain/geometry/public";
import { createSelectionFrameAtRotation } from "../../../../src/editor/selection/public";
import { TextEditingFrame } from "../../../../src/obsidian/embeds/active-editor/previews/text-editing-frame";

const scenes: SvgSceneRenderer[] = [];
afterEach(() => {
  for (const scene of scenes.splice(0)) scene.destroy();
  document.body.replaceChildren();
});

function fixture(fontResourceId?: string, element = textElement()) {
  installObsidianDomHelpers();
  const container = document.createElement("div");
  document.body.append(container);
  const store = new FakeSceneStore();
  if (fontResourceId !== undefined)
    element.layout.lines[0]!.runs[0]!.fontResourceId = fontResourceId;
  const record = createSceneRecord(element);
  store.records.set(element.id, record);
  store.records.set("shape", fakeRectangleRecord("shape", 1, 300));
  const scheduler = new FakeScheduler();
  const scene = new SvgSceneRenderer({
    container,
    page: createWorkerSnapshot([]).page,
    store,
    workScheduler: scheduler.workScheduler,
    reducedMotion: true,
    layout: { readViewport: () => ({ left: 0, top: 0, width: 2048, height: 1000 }) },
  });
  scenes.push(scene);
  return { scene, scheduler, store, element, record, container };
}

it.each([0, 30, 90])(
  "keeps retained text, editor and overlay moving through late native publication at %s degrees",
  (rotation) => {
    const { scene, scheduler, element } = fixture(undefined, textElement({ rotation }));
    scheduler.runAll();
    const root = scene.textDocument.querySelector<SVGGElement>(".inkbook-native-text")!;
    const published = vi.fn();
    const handle = scene.beginTextEditing(element.id, { onGeometryChanged: published })!;
    handle.setReady?.();
    handle.setSuspended(true);
    const input = root.querySelector("foreignObject")!;
    const scaled = scaleElement(element, { x: 0, y: 0 }, { x: 2, y: 2 });
    if (scaled.kind !== "text") throw new Error("Expected scaled text.");
    const basis = {
      ...scaled,
      height: scaled.height + 8,
      pivot: { x: scaled.pivot.x, y: scaled.pivot.y + 4 },
    };
    const matrix: AffineMatrix = [1.25, 0, 0, 1.25, 0, 0];
    const feedback = { matrix, textBasis: basis, transform: "scale(1.25)", inverse: "scale(.8)" };
    const bounds = (value: typeof element, preview: AffineMatrix) =>
      textRectBounds(
        {
          left: value.x,
          top: value.y,
          right: value.x + value.width,
          bottom: value.y + value.height,
        },
        textPreviewMatrix(value, preview),
      )!;
    let expected = bounds(basis, matrix);
    const readBounds = (value: typeof element) => {
      const coefficients = root
        .getAttribute("transform")!
        .match(/^matrix\(([^)]+)\)/u)![1]!
        .split(/\s+/u)
        .map(Number) as unknown as AffineMatrix;
      const result = bounds(value, coefficients);
      for (const key of ["minX", "minY", "maxX", "maxY"] as const)
        expect(result[key]).toBeCloseTo(expected[key], 8);
    };
    scene.setElementPreviews([basis], 1);
    scene.setPreviewTransform([element.id], feedback.transform, 2, "preserve", undefined, feedback);
    scene.setSelectionOverlayPath("M1 2L3 4", "none", "M5 6", true);
    scene.flushPointerFeedbackFrame();
    readBounds(element);
    expect(scene.textDocument.querySelector(".inkbook-selection-overlay")!.getAttribute("d")).toBe(
      "M1 2L3 4",
    );
    expect(published).not.toHaveBeenCalled();
    const clone = vi.spyOn(root, "cloneNode");
    for (let sample = 0; sample < 20; sample += 1) {
      const factor = 1.25 + (sample + 1) / 100;
      const next: AffineMatrix = [factor, 0, 0, factor, 0, 0];
      expected = bounds(basis, next);
      scene.setPreviewTransform(
        [element.id],
        `scale(${factor})`,
        sample + 3,
        "preserve",
        undefined,
        { ...feedback, matrix: next, transform: `scale(${factor})` },
      );
      scene.flushPointerFeedbackFrame();
      readBounds(element);
    }
    expect(root.querySelector("foreignObject")).toBe(input);
    expect(clone).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
    scheduler.runAll();
    readBounds(basis);
    expect(published).toHaveBeenCalledExactlyOnceWith(basis);
    expect(root.querySelector("foreignObject")).toBe(input);
    scene.clearPreviewTransforms();
    scene.clearElementPreviews();
    scheduler.runAll();
    expect(root.getAttribute("transform")).toBe(
      rotation === 0 ? null : `rotate(${rotation} ${element.pivot.x} ${element.pivot.y})`,
    );
  },
);

it("retains visible source extent through handle gestures and releases it on disposal", () => {
  const { scene, scheduler, element, store } = fixture(undefined, textElement({ rotation: 90 }));
  scheduler.runAll();
  const height = vi.fn();
  const handle = scene.beginTextEditing(element.id, { onContentHeightChanged: height })!;
  handle.setContentHeight(element.height + 80);
  expect(height).not.toHaveBeenCalled();
  handle.setReady?.();
  expect(height).toHaveBeenLastCalledWith(element.height + 80, element);
  handle.setContentHeight(element.height + 80);
  expect(height).toHaveBeenCalledOnce();
  handle.setContentHeight(element.height + 20);
  expect(height).toHaveBeenLastCalledWith(element.height + 20, element);
  handle.setContentHeight(0);
  expect(height).toHaveBeenLastCalledWith(element.height, element);
  handle.setSuspended(true);
  expect(height).toHaveBeenLastCalledWith(element.height, element);
  const count = height.mock.calls.length;
  handle.setContentHeight(element.height + 100);
  expect(height).toHaveBeenCalledTimes(count + 1);
  expect(height).toHaveBeenLastCalledWith(element.height + 100, element);
  handle.setSuspended(false);
  expect(height).toHaveBeenLastCalledWith(element.height + 100, element);
  const target = { ...element, height: element.height * 2 };
  const previous = height.mock.calls.length;
  handle.updateBounds(target, target);
  handle.setContentHeight(target.height + 50);
  expect(height.mock.calls.slice(previous)).toEqual([
    [target.height, target],
    [target.height + 50, target],
  ]);
  const editing = new TextEditingFrame();
  editing.set(target.id, target.height + 50, height.mock.lastCall![1] as typeof element);
  const selected = [{ element: target, bounds: calculateElementBounds(target) }];
  const expected = createSelectionFrameAtRotation(
    [{ ...target, height: target.height + 50 }],
    target.rotation,
  );
  expect(editing.preview(selected)).toEqual(expected);
  scene.setElementPreviews([target], 1);
  scheduler.runAll();
  handle.syncGeometry?.();
  expect(editing.preview(selected)).toEqual(expected);
  expect(height.mock.calls.slice(previous)).toHaveLength(2);
  handle.dispose();
  expect(height).toHaveBeenLastCalledWith(undefined, target);
  const disposed = height.mock.calls.length;
  handle.setContentHeight(element.height + 200);
  handle.setReady?.();
  handle.setSuspended(false);
  expect(height).toHaveBeenCalledTimes(disposed);
  expect(store.records.get(element.id)!.element).toBe(element);
});

it("keeps the source editor visible and synchronizes each published resize geometry once", () => {
  const { scene, scheduler, element, store } = fixture();
  scheduler.runAll();
  const geometry = vi.fn((preview: ReturnType<typeof textElement>) => handle.updateBounds(preview));
  const height = vi.fn();
  const handle = scene.beginTextEditing(element.id, {
    onGeometryChanged: geometry,
    onContentHeightChanged: height,
  })!;
  handle.setReady?.();
  handle.setContentHeight(element.height + 80);
  handle.setSuspended(true);
  const editor = scene.textDocument.querySelector("foreignObject")!;
  const preview = { ...element, width: element.width + 200 };
  scene.setElementPreviews([preview], 1);
  scheduler.runAll();
  expect(geometry).toHaveBeenCalledExactlyOnceWith(preview);
  expect(editor.getAttribute("visibility")).toBe("visible");
  expect(editor.getAttribute("width")).toBe(String(preview.width));
  expect(editor.getAttribute("height")).toBe(String(element.height + 80));
  expect(height).toHaveBeenLastCalledWith(element.height + 80, preview);
  for (let index = 0; index < 100; index += 1)
    handle.updateViewport({ left: 0, top: 0, width: 2048, height: 1000 }, { x: 0, zoom: 1 });
  expect(geometry).toHaveBeenCalledOnce();
  expect(store.records.get(element.id)!.element).toBe(element);
  scene.clearElementPreviews();
  scheduler.runAll();
  expect(geometry).toHaveBeenLastCalledWith(element);
  expect(height).toHaveBeenLastCalledWith(element.height + 80, element);
  handle.setSuspended(false);
  expect(editor.getAttribute("visibility")).toBe("visible");
  handle.dispose();
});

it("lets a visible resize handle claim a floating table control target before normal control ownership", () => {
  const { scene, scheduler, element } = fixture();
  scheduler.runAll();
  const claim = vi.fn(() => true);
  const owns = vi.fn(() => true);
  const outside = vi.fn();
  const handle = scene.beginTextEditing(element.id, {
    onPointerDown: claim,
    ownsPointerTarget: owns,
    onOutsidePointerDown: outside,
  })!;
  const button = scene.textDocument.createElement("button");
  scene.textDocument.body.append(button);
  const dispatch = () => {
    const event = new scene.textDocument.defaultView!.PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    button.dispatchEvent(event);
    return event;
  };
  expect(dispatch().defaultPrevented).toBe(true);
  expect(claim).toHaveBeenCalledOnce();
  expect(owns).not.toHaveBeenCalled();
  claim.mockReturnValue(false);
  expect(dispatch().defaultPrevented).toBe(false);
  expect(owns).toHaveBeenCalledOnce();
  expect(outside).not.toHaveBeenCalled();
  handle.dispose();
});

it.each([
  { title: null, language: null },
  { title: "Decorative scene", language: "fr" },
])(
  "labels the active text frame and restores original attributes (title: $title)",
  ({ title, language }) => {
    const { scene, scheduler, element, container } = fixture();
    const frame = container.firstElementChild!.shadowRoot!.querySelector("iframe")!;
    const drawingRoot = scene.textDocument.documentElement;
    if (title !== null) frame.setAttribute("title", title);
    if (language !== null) scene.textDocument.documentElement.setAttribute("lang", language);
    const originalLanguage = document.documentElement.getAttribute("lang");
    document.documentElement.setAttribute("lang", "de-DE");
    try {
      scheduler.runAll();
      const first = scene.beginTextEditing(element.id)!;
      const handle = scene.beginTextEditing(element.id)!;
      expect(scene.textDocument.title).toBe("Inkbook");
      expect(frame.getAttribute("title")).toBe("Text");
      expect(frame.hasAttribute("aria-hidden")).toBe(false);
      expect(scene.textDocument.documentElement.getAttribute("lang")).toBe("de-DE");
      handle.dispose();
      first.dispose();
      expect(frame.getAttribute("title")).toBe(title);
      expect(drawingRoot.getAttribute("lang")).toBe(language);
    } finally {
      if (originalLanguage === null) document.documentElement.removeAttribute("lang");
      else document.documentElement.setAttribute("lang", originalLanguage);
    }
  },
);

it("keeps an existing run bound to its original face when another resource is added", () => {
  const originalId = "a".repeat(64);
  const addedId = "b".repeat(64);
  const { scene, scheduler } = fixture(originalId);
  const face = (id: string) =>
    `@font-face{font-family:"inkbook-face-${id}";font-style:normal;font-weight:400;src:url("data:font/woff2;base64,AA==") format("woff2")}`;
  scene.setTextFonts(face(originalId));
  scheduler.runAll();
  const original = scene.svg.querySelector("tspan")!;
  expect(original.getAttribute("font-family")).toBe(`inkbook-face-${originalId}`);
  scene.setTextFonts(face(originalId) + face(addedId));
  expect(scene.svg.querySelector("tspan")).toBe(original);
  expect(original.getAttribute("font-family")).toBe(`inkbook-face-${originalId}`);
  expect(scene.textDocument.querySelectorAll("#inkbook-fonts")).toHaveLength(1);
});

it("awaits authoritative glyph publication and pins one editor through culling until disposal", async () => {
  const { scene, scheduler, store, element, record, container } = fixture();
  const initial = scene.waitForTextElement(element.id);
  const fonts =
    '@font-face{font-family:"inkbook-inter";font-style:normal;font-weight:400;src:url("data:font/woff2;base64,AA==") format("woff2")}';
  scene.setTextFonts(fonts);
  scene.setTextFonts(fonts);
  expect(scene.textDocument.querySelectorAll("#inkbook-fonts")).toHaveLength(1);
  expect(scene.textDocument.querySelector("#inkbook-fonts")?.textContent).toBe(fonts);
  scheduler.runAll();
  await initial;
  const root = scene.textDocument.querySelector<SVGGElement>(".inkbook-native-text")!;
  const parent = root.parentElement;
  const savedText = root.children[1]!;
  const nativeDocument = vi.spyOn(HTMLIFrameElement.prototype, "contentDocument", "get");
  nativeDocument.mockReturnValueOnce(null);
  expect(() => scene.beginTextEditing(element.id)).toThrow("Text input document unavailable");
  nativeDocument.mockRestore();
  expect(scene.svg.hasAttribute("data-inkbook-text-editing")).toBe(false);
  expect(root.querySelector("foreignObject")).toBeNull();
  const handle = scene.beginTextEditing(element.id)!;
  expect(scene.svg.hasAttribute("data-inkbook-text-editing")).toBe(true);
  const editing = root.querySelector("foreignObject")!;
  expect(editing.parentElement).toBe(root);
  expect(root.parentElement).toBe(parent);
  expect(editing.getAttribute("visibility")).toBe("hidden");
  expect(savedText.getAttribute("visibility")).toBeNull();
  handle.setReady?.();
  expect(editing.getAttribute("visibility")).toBe("visible");
  expect(savedText.getAttribute("visibility")).toBe("hidden");
  expect(root.nextElementSibling?.localName).toBe("path");
  expect(handle.ownerDocument).not.toBe(scene.textDocument);
  expect(handle.coordinates.drawingDocument).toBe(scene.textDocument);
  scene.setViewport({ left: 0, top: 100_000, width: 2048, height: 1000 });
  scheduler.runAll();
  expect(handle.container.isConnected).toBe(true);
  expect(scene.mountedCount).toBe(1);
  const changed = singleLineTextElement("new");
  const next = { ...createSceneRecord(changed), geometryVersion: 2, paintVersion: 2 };
  store.records.set(element.id, next);
  scene.applyDelta({
    affected: [
      {
        id: element.id,
        domains: ["geometry", "paint", "visibility"],
        before: element,
        after: changed,
        beforeBounds: record.bounds,
        afterBounds: next.bounds,
      },
    ],
  });
  let published = false;
  const updated = scene.waitForTextElement(element.id).then(() => {
    published = true;
  });
  expect(published).toBe(false);
  scheduler.runAll();
  await updated;
  expect(root.querySelector("tspan")?.textContent).toBe("new");
  expect(handle.container.isConnected).toBe(true);
  handle.dispose();
  expect(editing.isConnected).toBe(false);
  expect(root.hasAttribute("data-inkbook-text-editor-ready")).toBe(false);
  expect(scene.svg.hasAttribute("data-inkbook-text-editing")).toBe(false);
  scheduler.runAll();
  expect(scene.mountedCount).toBe(0);
  const frame = container.querySelector(".inkbook-scene")!.shadowRoot!.querySelector("iframe")!;
  expect(frame.hasAttribute("inert")).toBe(true);
  expect(scene.inputSurface.style.pointerEvents).toBe("");
});

it("inherits text transforms and preserves visible feedback through zoom and suspension", () => {
  const { scene, scheduler, element } = fixture(undefined, textElement({ rotation: 90 }));
  scene.setCamera({ x: -30, zoom: 2 });
  scheduler.runAll();
  const root = scene.textDocument.querySelector<SVGGElement>(".inkbook-native-text")!;
  const overlay = scene.textDocument.querySelector(".inkbook-selection-overlay")!;
  const handles = scene.textDocument.querySelector(".inkbook-selection-handles")!;
  const traces = scene.textDocument.querySelector(".inkbook-selection-traces")!;
  const handle = scene.beginTextEditing(element.id)!;
  const editor = root.querySelector("foreignObject")!;
  expect(editor.parentElement).toBe(root);
  expect(editor.hasAttribute("transform")).toBe(false);
  expect(root.getAttribute("transform")).toBe("rotate(90 110 70)");
  expect(root.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  handle.setSuspended(true);
  handle.setReady?.();
  expect(editor.getAttribute("visibility")).toBe("visible");
  expect(editor.getAttribute("pointer-events")).toBe("none");
  expect(root.children[1]!.getAttribute("visibility")).toBe("hidden");
  handle.setSuspended(false);
  expect(editor.getAttribute("pointer-events")).toBe("auto");
  expect(editor.getAttribute("visibility")).toBe("visible");
  expect(root.children[1]!.getAttribute("visibility")).toBe("hidden");
  const view = scene.textDocument.defaultView!;
  expect(view.getComputedStyle(overlay).visibility).not.toBe("hidden");
  expect(view.getComputedStyle(overlay).fill).toBe("none");
  expect(view.getComputedStyle(handles).visibility).not.toBe("hidden");
  expect(view.getComputedStyle(traces).visibility).toBe("hidden");
  expect(view.getComputedStyle(root.children[0]!).visibility).toBe("hidden");
  scheduler.runAll();
  const writes = vi.spyOn(editor, "setAttribute");
  scene.setViewport({ left: 0, top: 100, width: 2048, height: 900 });
  scheduler.runAll();
  expect(writes).not.toHaveBeenCalled();
  scene.setCamera({ x: 0, zoom: 1 });
  scheduler.runAll();
  expect(writes).not.toHaveBeenCalled();
  expect(editor.parentElement).toBe(root);
  expect(root.getAttribute("transform")).toBe("rotate(90 110 70)");
  handle.setSuspended(true);
  expect(view.getComputedStyle(root.children[0]!).visibility).toBe("hidden");
  expect(root.children[1]!.getAttribute("visibility")).toBe("hidden");
  handle.setSuspended(false);
  handle.dispose();
  expect(editor.isConnected).toBe(false);
  expect(root.hasAttribute("data-inkbook-text-editor-ready")).toBe(false);
  expect(root.children[1]!.hasAttribute("visibility")).toBe(false);
  writes.mockRestore();
});

it("resolves authoritative text readiness after cancelling a published style preview", async () => {
  const { scene, scheduler, element, record, store } = fixture();
  scheduler.runAll();
  const preview = { ...element, style: { ...element.style, fontSize: 48 } };
  scene.setElementPreviews([preview], 1);
  scheduler.runAll();
  expect(scene.textDocument.querySelector("tspan")!.getAttribute("font-size")).toBe("48");
  scene.clearElementPreviews();
  scene.flushPointerFeedbackFrame();
  let ready = false;
  const restored = scene.waitForTextElement(element.id).then(() => {
    ready = true;
  });
  expect(ready).toBe(false);
  scheduler.runAll();
  await restored;
  expect(ready).toBe(true);
  expect(scene.textDocument.querySelector("tspan")!.getAttribute("font-size")).toBe("24");
  expect(store.records.get(element.id)).toBe(record);
});

it("cancels readiness without frame polling or retaining a pending promise", async () => {
  const { scene, scheduler, store, element, record } = fixture();
  const unpublished = scene.waitForTextElement(element.id);
  const removed = expect(unpublished).rejects.toMatchObject({ name: "AbortError" });
  store.records.delete(element.id);
  scene.applyDelta({
    historyReplay: true,
    affected: [
      {
        id: element.id,
        domains: ["geometry", "visibility"],
        before: element,
        after: null,
        beforeBounds: record.bounds,
        afterBounds: null,
      },
    ],
  });
  await removed;
  const abort = new AbortController();
  const pending = scene.waitForTextElement("missing", abort.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  abort.abort();
  await rejected;
  scheduler.runAll();
  const second = scene.waitForTextElement("missing");
  const disposed = expect(second).rejects.toMatchObject({ name: "AbortError" });
  scene.destroy();
  await disposed;
  expect(scheduler.pendingCount).toBe(0);
});

it("restores selection feedback when the active text is removed from the scene", () => {
  const { scene, scheduler, store, element, record } = fixture();
  scheduler.runAll();
  const handle = scene.beginTextEditing(element.id)!;
  expect(scene.svg.hasAttribute("data-inkbook-text-editing")).toBe(true);
  store.records.delete(element.id);
  scene.applyDelta({
    affected: [
      {
        id: element.id,
        domains: ["geometry", "visibility"],
        before: element,
        after: null,
        beforeBounds: record.bounds,
        afterBounds: null,
      },
    ],
  });
  scheduler.runAll();
  expect(handle.container.isConnected).toBe(false);
  expect(scene.svg.hasAttribute("data-inkbook-text-editing")).toBe(false);
  expect(scene.inputSurface.hasAttribute("inert")).toBe(false);
});
