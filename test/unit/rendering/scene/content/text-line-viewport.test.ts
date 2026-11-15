import { FakeSceneStore } from "../fakes";
// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { MountedTextPresentation } from "../../../../../src/rendering/scene/content/mounted-text";
import { TextViewportPublication } from "../../../../../src/rendering/scene/content/text-viewport-publication";
import {
  createMountedElement,
  setMountedElementMotion,
} from "../../../../../src/rendering/scene/content/mounted-element";
import { createInstrumentation } from "../../../../../src/rendering/scene/instrumentation";
import type { Bounds } from "../../../../../src/domain/geometry/primitives";
import { textElement } from "../../../../fixtures/rendering/text";
import { createSceneRecord } from "../../../../fixtures/rendering/scene";
import { SceneMountPreparation } from "../../../../../src/rendering/scene/reconciliation/scene-mount-preparation";
import { MountSlice } from "../../../../../src/rendering/scene/reconciliation/mount-slice";
import { ScenePathCache } from "../../../../../src/rendering/scene/content/path-cache";
import { DetachedSceneElementCache } from "../../../../../src/rendering/scene/content/detached-element-cache";

function field(count = 200) {
  const source = Array.from(
    { length: count },
    (_, index) => `row${String(index).padStart(3, "0")}`,
  ).join("\n");
  const element = textElement({ source, width: 200, height: count * 40 });
  element.style = { ...element.style, fontSize: 10 };
  element.layout.lines = source.split("\n").map((text, index) => ({
    x: 10,
    y: index * 40,
    width: 60,
    height: 16,
    baseline: 12,
    runs: [{ text, start: index * 7, end: index * 7 + 6, x: 0, width: 60 }],
  }));
  return element;
}

function lines(text: MountedTextPresentation) {
  return new Map(
    Array.from(text.content.querySelectorAll("text"), (node) => [node.textContent, node]),
  );
}

function presentation(element: ReturnType<typeof field>, window: () => Bounds | undefined) {
  return new MountedTextPresentation(document, element, createInstrumentation(), false, window);
}

function viewportField() {
  const element = field();
  let bounds = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
  const text = presentation(element, () => bounds);
  return {
    element,
    text,
    original: lines(text),
    moveViewport: (next: Bounds) => {
      bounds = next;
    },
  };
}

function retainInitialText(
  element: ReturnType<typeof field>,
  viewport: TextViewportPublication,
  cache: DetachedSceneElementCache,
  stats: ReturnType<typeof createInstrumentation>,
) {
  const text = new MountedTextPresentation(document, element, stats, false, viewport.localBounds);
  const retained = createMountedElement(document, createSceneRecord(element), [], stats, text);
  document.body.append(retained.group!);
  expect(lines(text).has("row000")).toBe(true);
  retained.group!.remove();
  expect(cache.retain(retained)).toBe(true);
  return retained;
}

it("retains overlapping native lines and complete structured paint while changing the visible window", () => {
  const element = field();
  element.layout.math = [
    {
      start: 0,
      end: 1,
      display: true,
      x: 0,
      y: 900,
      width: 20,
      height: 20,
      paths: [{ d: "M0 0L1 1" }],
    },
  ];
  element.layout.tables = [
    {
      start: 0,
      end: 1,
      x: 0,
      y: 1100,
      width: 80,
      height: 40,
      columns: 2,
      rowHeights: [20, 20],
      borderWidth: 1,
    },
  ];
  let window: Bounds | undefined = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
  const text = presentation(element, () => window);
  const original = lines(text);
  const paths = Array.from(text.content.querySelectorAll("path"));
  const scratch = text.content.firstElementChild;
  expect(original.size).toBe(4);
  expect(paths).toHaveLength(2);
  expect(text.motionSnapshot(element, 1000, 1_000_000)).toBeUndefined();
  const create = vi.spyOn(document, "createElementNS");
  try {
    window = { minX: 0, minY: 80, maxX: 200, maxY: 180 };
    expect(text.prepareViewport(Infinity, () => 0)).toBe(true);
    const scrolled = lines(text);
    expect(scrolled.has("row000")).toBe(false);
    expect(scrolled.get("row001")).toBe(original.get("row001"));
    expect(scrolled.get("row003")).toBe(original.get("row003"));
    expect(scrolled.has("row004")).toBe(true);
    expect(create.mock.calls.filter(([, tag]) => tag === "tspan")).toHaveLength(2);
    expect(text.content.firstElementChild).toBe(scratch);
    expect(Array.from(text.content.querySelectorAll("path"))).toEqual(paths);
    window = undefined;
    expect(text.prepareViewport(Infinity, () => 0)).toBe(true);
    expect(lines(text).size).toBe(200);
    expect(
      text.motionSnapshot(element, 1000, 1_000_000)?.root.querySelectorAll("text"),
    ).toHaveLength(200);
  } finally {
    create.mockRestore();
  }
});

it("reuses exact unchanged line values from new layout arrays and replaces only changed paint", () => {
  const element = field();
  const window = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
  const text = presentation(element, () => window);
  const original = lines(text);
  const layout = {
    ...element.layout,
    lines: element.layout.lines.map((line) => ({
      ...line,
      runs: line.runs.map((run) => ({ ...run })),
    })),
  };
  const updated = {
    ...element,
    style: { ...element.style, color: { ...element.style.color } },
    layout,
  };
  const create = vi.spyOn(document, "createElementNS");
  try {
    text.update(updated);
    expect(lines(text)).toEqual(original);
    expect(create.mock.calls.filter(([, tag]) => tag === "tspan")).toHaveLength(0);
    const changed = {
      ...updated,
      layout: {
        ...layout,
        lines: layout.lines.map((line, index) =>
          index === 2 ? { ...line, runs: [{ ...line.runs[0]!, style: { bold: true } }] } : line,
        ),
      },
    };
    text.update(changed);
    expect(lines(text).get("row001")).toBe(original.get("row001"));
    expect(lines(text).get("row002")).not.toBe(original.get("row002"));
    expect(lines(text).get("row002")!.firstElementChild!.getAttribute("font-weight")).toBe("700");
    expect(create.mock.calls.filter(([, tag]) => tag === "tspan")).toHaveLength(1);
  } finally {
    create.mockRestore();
  }
});

it("abandons a pending window without touching retained paint or keeping its staged resources", () => {
  const { text, original, moveViewport } = viewportField();
  const memory = text.memoryUsage();
  moveViewport({ minX: 0, minY: 800, maxX: 200, maxY: 900 });
  expect(text.prepareViewport(0, () => 1)).toBe(false);
  expect(text.memoryUsage()).toBeGreaterThan(memory);
  expect(lines(text)).toEqual(original);
  text.cancelViewport();
  expect(text.memoryUsage()).toBe(memory);
  expect(text.prepareViewport(Infinity, () => 0)).toBe(true);
  expect(lines(text).has("row020")).toBe(true);
  expect(lines(text).has("row000")).toBe(false);
});

it("projects the page viewport through the same rotation and preview affine as native editing", () => {
  const element = { ...field(), x: 0, y: 0, rotation: 90, pivot: { x: 0, y: 0 } };
  const record = createSceneRecord(element);
  const entry = createMountedElement(document, record, [], createInstrumentation());
  const mounted = new Map([[element.id, entry]]);
  const viewport = new TextViewportPublication(mounted, () => ({
    matrix: [2, 0, 0, 2, 100, 200],
    transform: null,
    version: 1,
    strokeWidthScale: null,
  }));
  viewport.mount(entry);
  viewport.set({ minX: 60, maxX: 100, minY: 200, maxY: 240 });
  const bounds = viewport.localBounds(element)!;
  expect(bounds.minX).toBeCloseTo(0);
  expect(bounds.maxX).toBeCloseTo(20);
  expect(bounds.minY).toBeCloseTo(0);
  expect(bounds.maxY).toBeCloseTo(20);
  setMountedElementMotion(entry, 0.5, 0.5);
  viewport.set({ minX: -10, maxX: 0, minY: 0, maxY: 10 });
  expect(viewport.localBounds(element)!.maxX).toBeCloseTo(20);
  expect(viewport.localBounds(element)!.maxY).toBeCloseTo(20);
  const scan = vi.spyOn(mounted, "values");
  try {
    viewport.refresh();
    expect(viewport.write(Infinity, () => 0)).toBe(false);
    expect(scan).not.toHaveBeenCalled();
  } finally {
    scan.mockRestore();
  }
  viewport.remove(element.id);
  viewport.release();
  expect(viewport.memoryUsage()).toBe(0);
});

it("keeps new and retained window lines in the original paint coordinate system after a move", () => {
  const { element, text, original, moveViewport } = viewportField();
  const moved = { ...element, x: element.x + 80, y: element.y + 60, rotation: 30 };
  text.update(moved);
  moveViewport({ minX: 0, minY: 40, maxX: 200, maxY: 140 });
  expect(text.prepareViewport(Infinity, () => 0)).toBe(true);
  expect(text.content.getAttribute("transform")).toBe("translate(80 60)");
  expect(lines(text).get("row001")).toBe(original.get("row001"));
  const newLine = lines(text).get("row004")!.firstElementChild!;
  expect(newLine.getAttribute("x")).toBe(String(element.x + 10));
  expect(newLine.getAttribute("y")).toBe(String(element.y + 160 + 12));
});

it("queries nonmonotonic table-cell line positions without sorting away their paint order", () => {
  const element = field();
  const prefix = [20, 1, 30, 0, 2];
  element.layout.lines = [
    ...prefix.map((index) => element.layout.lines[index]!),
    ...element.layout.lines.filter((_, index) => !prefix.includes(index)),
  ];
  const text = new MountedTextPresentation(
    document,
    element,
    createInstrumentation(),
    false,
    () => ({ minX: 0, minY: 0, maxX: 200, maxY: 100 }),
  );
  expect([...lines(text).keys()]).toEqual(["row001", "row000", "row002", "row003"]);
});

it("retains complete small text fields within the existing motion node budget", () => {
  const element = field(40);
  let window = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
  const text = presentation(element, () => window);
  expect(lines(text).size).toBe(40);
  expect(text.motionSnapshot(element, 256, 1_000_000)).toBeDefined();
  const original = lines(text);
  window = { minX: 0, minY: 800, maxX: 200, maxY: 900 };
  expect(text.prepareViewport(0, () => 1)).toBe(true);
  expect(lines(text)).toEqual(original);
});

it.each(["cached", "new-preview", "preview-reset"] as const)(
  "finishes the current text window before a %s entrant can be published",
  (mode) => {
    const element = field();
    const record = createSceneRecord(element);
    const store = new FakeSceneStore();
    store.records.set(element.id, record);
    const cache = new DetachedSceneElementCache();
    const stats = createInstrumentation();
    const viewport = new TextViewportPublication(new Map(), () => undefined);
    viewport.set({ minX: 0, minY: 0, maxX: 200, maxY: 100 });
    let retained: ReturnType<typeof createMountedElement> | undefined;
    if (mode === "cached") {
      retained = retainInitialText(element, viewport, cache, stats);
      viewport.set({ minX: 0, minY: 6000, maxX: 200, maxY: 6100 });
    }
    const preparation = new SceneMountPreparation({
      ownerDocument: document,
      instrumentation: stats,
      pathCache: new ScenePathCache(),
      store,
      detachedCache: cache,
      textViewport: viewport.localBounds,
    });
    let clock = 0;
    const allocated: Element[] = [];
    const create = document.createElementNS.bind(document);
    const allocation = vi.spyOn(document, "createElementNS").mockImplementation((...args) => {
      clock += 1;
      const node = create(...args);
      allocated.push(node);
      return node;
    });
    const preview =
      mode !== "cached"
        ? {
            matrix: [1, 0, 0, 1, 0, -6000] as const,
            transform: "translate(0 -6000)",
            version: 1,
            strokeWidthScale: null,
            ...(mode === "preview-reset" ? { textBasis: element } : {}),
          }
        : undefined;
    let staged: ReturnType<typeof createMountedElement> | undefined;
    let previewRoot: Element | undefined;
    try {
      for (let slice = 0; !staged && slice < 100; slice += 1) {
        staged = preparation.stage(
          record,
          new MountSlice(clock + 1, () => clock),
          previewRoot ? undefined : preview,
        );
        expect(document.body.querySelector(".inkbook-native-text")).toBeNull();
        if (mode === "preview-reset" && !previewRoot) {
          previewRoot = allocated.find(
            (node) =>
              node.getAttribute("class") === "inkbook-native-text" &&
              node.getAttribute("transform")?.includes("-6000"),
          );
          if (previewRoot) expect(staged).toBeUndefined();
        }
      }
      expect(staged).toBeDefined();
      expect(lines(staged!.text!).has("row150")).toBe(mode !== "preview-reset");
      expect(lines(staged!.text!).has("row000")).toBe(mode === "preview-reset");
      if (mode === "preview-reset") {
        expect(staged!.group).toBe(previewRoot);
        expect(staged!.appliedPreviewTransform).toBeNull();
        expect(staged!.text!.previewMatrix).toBeUndefined();
        expect(staged!.textScaleFeedback).toBeUndefined();
      }
      if (retained) expect(staged).toBe(retained);
      document.body.append(staged!.group!);
      expect(document.body.querySelector(".inkbook-native-text")).toBe(staged!.group);
    } finally {
      allocation.mockRestore();
      staged?.group?.remove();
      preparation.cancel();
      cache.dispose();
      viewport.release();
    }
  },
);

function mountedViewportFields(count: number) {
  const mounted = new Map<string, ReturnType<typeof createMountedElement>>();
  const viewport = new TextViewportPublication(mounted, () => undefined);
  viewport.set({ minX: 0, minY: 0, maxX: 200, maxY: 100 });
  const texts = Array.from({ length: count }, (_, index) => {
    const element = {
      ...field(),
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    };
    const text = new MountedTextPresentation(
      document,
      element,
      createInstrumentation(),
      false,
      viewport.localBounds,
    );
    const entry = createMountedElement(
      document,
      createSceneRecord(element),
      [],
      createInstrumentation(),
      text,
    );
    mounted.set(element.id, entry);
    viewport.mount(entry);
    return text;
  });
  return { viewport, texts };
}

it("publishes the final viewport for fields visited before an in-flight scan was refreshed", () => {
  const { viewport, texts } = mountedViewportFields(2);
  viewport.write(Infinity, () => 0);
  const first = texts[0]!;
  const prepareFirst = first.prepareViewport.bind(first);
  let paused = false;
  const prepare = texts.map((text) => vi.spyOn(text, "prepareViewport"));
  prepare[0]!.mockImplementation((deadline, now) => {
    const complete = prepareFirst(deadline, now);
    paused = true;
    return complete;
  });
  try {
    viewport.set({ minX: 0, minY: 800, maxX: 200, maxY: 900 });
    expect(viewport.write(1, () => (paused ? 1 : 0))).toBe(true);
    expect(lines(first).has("row020")).toBe(true);
    expect(prepare[1]).not.toHaveBeenCalled();
    for (const minY of [1200, 1600, 2000])
      viewport.set({ minX: 0, minY, maxX: 200, maxY: minY + 100 });
    expect(viewport.write(Infinity, () => 0)).toBe(false);
    for (const text of texts) {
      expect(lines(text).has("row050")).toBe(true);
      expect(lines(text).has("row020")).toBe(false);
    }
    for (const spy of prepare) expect(spy).toHaveBeenCalledTimes(2);
    expect(viewport.pending).toBe(false);
  } finally {
    for (const spy of prepare) spy.mockRestore();
    viewport.release();
  }
});

it("advances text windows fairly while every short admitted slice receives newer viewport bounds", () => {
  const { viewport, texts } = mountedViewportFields(3);
  const prepare = texts.map((text) => vi.spyOn(text, "prepareViewport"));
  let clock = 0;
  try {
    for (let slice = 0; slice < 300; slice += 1) {
      viewport.set({ minX: slice / 1000, minY: 800, maxX: 200 + slice / 1000, maxY: 900 });
      viewport.write(clock + 2, () => ++clock);
    }
    for (let index = 0; index < texts.length; index += 1) {
      expect(prepare[index]!.mock.calls.length).toBeGreaterThan(1);
      expect(lines(texts[index]!).has("row020")).toBe(true);
      expect(lines(texts[index]!).has("row000")).toBe(false);
    }
  } finally {
    for (const spy of prepare) spy.mockRestore();
    viewport.release();
  }
  expect(viewport.pending).toBe(false);
  expect(viewport.memoryUsage()).toBe(0);
});
