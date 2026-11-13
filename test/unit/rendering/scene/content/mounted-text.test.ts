// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { textElement } from "../../../../fixtures/rendering/text";
import { createSceneRecord } from "../../../../fixtures/rendering/scene";
import { createInstrumentation } from "../../../../../src/rendering/scene/instrumentation";
import {
  createMountedElement,
  firstPath,
  updateMountedGeometry,
  updatePreviewTransform,
  setMountedElementMotion,
} from "../../../../../src/rendering/scene/content/mounted-element";
import { createTextEditingSurface } from "../../../../../src/rendering/scene/text-editing-surface";
import {
  createMotionVisual,
  removeMotionVisual,
  writeMotionVisual,
} from "../../../../../src/rendering/scene/presentation/motion-visual";
import { textBackgroundGeometrySteps } from "../../../../../src/domain/geometry/text-backgrounds";
import { finishGeometrySteps } from "../../../../fixtures/domain/geometry-steps";
import { textTableGridPathSteps } from "../../../../../src/domain/geometry/text-table-grid-path";

it("preserves spaces across SVG text runs through the actual XML namespace", () => {
  const element = textElement({ source: "a ccccx" });
  element.layout.lines[0]!.runs = [
    { text: "a", start: 0, end: 1, x: 0, width: 8 },
    { text: " ccccx", start: 1, end: 7, x: 8, width: 48, style: { bold: true } },
  ];
  const entry = createMountedElement(
    document,
    createSceneRecord(element),
    [],
    createInstrumentation(),
  );
  const text = entry.text!.content.querySelector("text")!;
  const attribute = text.getAttributeNodeNS("http://www.w3.org/XML/1998/namespace", "space");
  expect(attribute?.value).toBe("preserve");
  expect(attribute?.prefix).toBe("xml");
  expect(text.getAttributeNodeNS(null, "xml:space")).toBeNull();
  expect(Array.from(text.querySelectorAll("tspan"), (span) => span.textContent)).toEqual([
    "a",
    " ccccx",
  ]);
});

it("shares transparent cutouts and retained inline backgrounds with canonical geometry during translation", () => {
  const element = textElement();
  element.layout.lines[0]!.runs[0]!.style = {
    backgroundColor: { type: "rgba", value: "#113399FF" },
    backgroundOpacity: 0.125,
  };
  const expected = finishGeometrySteps(textBackgroundGeometrySteps(element));
  const entry = createMountedElement(
    document,
    createSceneRecord(element),
    [],
    createInstrumentation(),
  );
  const root = firstPath(entry);
  expect(root.firstElementChild!.getAttribute("d")).toBe(expected.basePath);
  const highlight = entry.text!.content.querySelector("path")!;
  expect(highlight.getAttribute("d")).toBe(expected.paints[0]!.d);
  expect(highlight.getAttribute("fill-opacity")).toBe("0.125");
  const moved = {
    ...element,
    x: element.x + 40,
    pivot: { ...element.pivot, x: element.pivot.x + 40 },
  };
  entry.text!.update(moved);
  expect(entry.text!.content.querySelector("path")).toBe(highlight);
  expect(root.firstElementChild!.getAttribute("transform")).toBe("translate(40 0)");
  expect(entry.text!.content.getAttribute("transform")).toBe("translate(40 0)");
});

it.each([
  { source: "\u200b", text: "\u200b", width: 0 },
  { source: "$x$", text: "", width: 24 },
])(
  "pins native glyph advance and drops constraints for a $text run with width $width",
  ({ source, text, width }) => {
    const element = textElement();
    const stats = createInstrumentation();
    const entry = createMountedElement(document, createSceneRecord(element), [], stats);
    const root = firstPath(entry);
    const initial = root.querySelector("tspan")!;
    expect(initial.getAttribute("textLength")).toBe("160");
    expect(initial.getAttribute("lengthAdjust")).toBe("spacingAndGlyphs");
    const range = document.createRange();
    range.selectNodeContents(initial);
    expect(range.toString()).toBe(element.source);
    const updated = {
      ...element,
      source,
      layout: {
        version: 1 as const,
        lines: [
          {
            x: 0,
            y: 0,
            baseline: 23,
            height: 30,
            width,
            runs: [{ start: 0, end: source.length, x: 0, width, text }],
          },
        ],
        ...(text === ""
          ? {
              math: [
                {
                  start: 0,
                  end: source.length,
                  display: false,
                  x: 0,
                  y: 0,
                  width,
                  height: 24,
                  paths: [{ d: "M0 0L1 1" }],
                },
              ],
            }
          : {}),
      },
    };
    updateMountedGeometry(
      entry,
      { ...createSceneRecord(updated), geometryVersion: 2 },
      [],
      document,
      document.createElementNS("http://www.w3.org/2000/svg", "g"),
      stats,
    );
    expect(firstPath(entry)).toBe(root);
    const span = root.querySelector("tspan")!;
    expect(span.getAttribute("textLength")).toBeNull();
    expect(span.getAttribute("lengthAdjust")).toBeNull();
    expect(span.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(span.textContent).toBe(text);
    expect(root.querySelector("image, foreignObject")).toBeNull();
  },
);

it("keeps a bound face and synthetic emphasis when an immutable text field moves", () => {
  const id = "a".repeat(64);
  const element = textElement();
  element.style = { ...element.style, bold: true, italic: true };
  element.layout.lines[0]!.runs[0]!.fontResourceId = id;
  Object.freeze(element.layout.lines[0]!.runs[0]);
  Object.freeze(element.layout.lines[0]!.runs);
  Object.freeze(element.layout.lines);
  Object.freeze(element.layout);
  Object.freeze(element);
  const stats = createInstrumentation();
  const entry = createMountedElement(document, createSceneRecord(element), [], stats);
  const span = firstPath(entry).querySelector("tspan")!;
  expect(span.getAttribute("font-family")).toBe(`inkbook-face-${id}`);
  expect(span.getAttribute("font-weight")).toBe("700");
  expect(span.getAttribute("font-style")).toBe("italic");
  const moved = { ...element, x: 50, pivot: { x: 150, y: 70 } };
  updateMountedGeometry(
    entry,
    createSceneRecord(moved),
    [],
    document,
    document.createElementNS("http://www.w3.org/2000/svg", "g"),
    stats,
  );
  expect(firstPath(entry).querySelector("tspan")).toBe(span);
  expect(span.getAttribute("font-family")).toBe(`inkbook-face-${id}`);
  expect(entry.text!.content.getAttribute("transform")).toBe("translate(40 0)");
});

it("keeps native text, background and safe math in one ordered retained root", () => {
  const element = textElement({
    rotation: 10,
    ranges: [
      { start: 0, end: 1, style: { color: { type: "rgba", value: "#123456FF" }, opacity: 0.25 } },
    ],
    layout: {
      version: 1,
      lines: textElement().layout.lines,
      tables: [
        {
          start: 0,
          end: 1,
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          columns: 2,
          rowHeights: [20, 20],
          borderWidth: 1,
        },
      ],
      math: [
        {
          start: 0,
          end: 1,
          display: false,
          x: 80,
          y: 30,
          width: 30,
          height: 30,
          paths: [{ d: "M0 0L1 1", fillRule: "evenodd" }],
        },
      ],
    },
  });
  const stats = createInstrumentation();
  const entry = createMountedElement(document, createSceneRecord(element), [], stats);
  const root = firstPath(entry);
  expect(entry.paths).toHaveLength(0);
  expect([...root.children].map((node) => node.localName)).toEqual(["path", "g"]);
  const span = root.querySelector("tspan")!;
  const grid = [...root.querySelectorAll("path")].find(
    (node) =>
      node.getAttribute("d") ===
      finishGeometrySteps(textTableGridPathSteps(element.layout.tables![0]!)),
  )!;
  expect(grid.getAttribute("transform")).toBe("translate(10 20)");
  expect(grid.getAttribute("fill-opacity")).toBe("0.75");
  expect(span.textContent).toBe("Hello & <world>");
  expect(span.getAttribute("font-family")).toBe("inkbook-inter");
  expect(span.getAttribute("x")).toBe("16");
  expect(span.getAttribute("y")).toBe("46");
  expect(
    root.querySelector('path[fill-rule="evenodd"]')?.parentElement?.getAttribute("transform"),
  ).toBe("translate(90 50)");
  expect(root.querySelector('path[fill-rule="evenodd"]')?.parentElement?.getAttribute("fill")).toBe(
    "#123456FF",
  );
  expect(
    root.querySelector('path[fill-rule="evenodd"]')?.parentElement?.getAttribute("fill-opacity"),
  ).toBe("0.25");
  updatePreviewTransform(entry, "scale(2)", 1, null, stats);
  expect(root.getAttribute("transform")).toBe("scale(2) rotate(10 110 70)");
  setMountedElementMotion(entry, 0.5, 0.96);
  expect(root.style.transformOrigin).toBe("110px 70px");
  expect(root.style.transform).toBe("rotate(10deg) scale(0.96)");
  setMountedElementMotion(entry, null);
  expect(root.style.transformOrigin).toBe("");
  expect(root.getAttribute("transform")).toBe("scale(2) rotate(10 110 70)");
  const count = stats.contentGeometryWrites;
  const moved = { ...element, x: 30, pivot: { x: 130, y: 70 } };
  updateMountedGeometry(
    entry,
    createSceneRecord(moved),
    [],
    document,
    document.createElementNS("http://www.w3.org/2000/svg", "g"),
    stats,
  );
  expect(firstPath(entry)).toBe(root);
  expect(root.querySelector("tspan")).toBe(span);
  expect([...root.querySelectorAll("path")]).toContain(grid);
  expect(entry.text?.content.getAttribute("transform")).toBe("translate(20 0)");
  expect(stats.contentGeometryWrites - count).toBeLessThanOrEqual(3);
});

it("copies bounded native text tombstones from retained nodes without copying a runtime editor", () => {
  const element = textElement();
  const entry = createMountedElement(
    document,
    createSceneRecord(element),
    [],
    createInstrumentation(),
  );
  document.body.append(firstPath(entry));
  const handle = createTextEditingSurface(entry.text!, element, {}, () => undefined);
  handle.setReady?.();
  const parent = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const read = {
    path: () => undefined,
    text: (_: unknown, nodes: number, bytes: number) =>
      entry.text!.motionSnapshot(element, nodes, bytes),
  };
  const insufficient = createMotionVisual(document, parent, [element], 5, 100_000, read);
  expect(insufficient.nodes).toHaveLength(0);
  const visual = createMotionVisual(document, parent, [element], 256, 100_000, read);
  expect(visual.nodes).toHaveLength(6);
  expect(parent.querySelector("foreignObject")).toBeNull();
  expect(parent.querySelector("tspan")?.textContent).toBe(element.source);
  expect(parent.querySelector('[visibility="hidden"]')).toBeNull();
  expect(parent.querySelector("[data-inkbook-text-editor-ready]")).toBeNull();
  writeMotionVisual(visual, 0.5, 0.96);
  expect(parent.firstElementChild?.getAttribute("style")).toContain("opacity: 0.5");
  removeMotionVisual(visual);
  expect(parent.children).toHaveLength(0);
  handle.dispose();
  firstPath(entry).remove();
});

it("offers editor pointer-down hits before native input and outside completion", () => {
  const element = textElement();
  const entry = createMountedElement(
    document,
    createSceneRecord(element),
    [],
    createInstrumentation(),
  );
  document.body.append(firstPath(entry));
  const accepted = vi.fn(() => true);
  const outside = vi.fn();
  const input = vi.fn();
  const handle = createTextEditingSurface(
    entry.text!,
    element,
    {
      onPointerDown: accepted,
      onOutsidePointerDown: outside,
    },
    () => undefined,
  );
  handle.container.addEventListener("pointerdown", input);
  const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
  handle.container.dispatchEvent(event);
  expect(accepted).toHaveBeenCalledExactlyOnceWith(event);
  expect(event.defaultPrevented).toBe(true);
  expect(input).not.toHaveBeenCalled();
  expect(outside).not.toHaveBeenCalled();
  handle.dispose();
  handle.container.removeEventListener("pointerdown", input);
  firstPath(entry).remove();
});

it("keeps floating text controls clickable before routing canvas input or outside completion", ({
  onTestFinished,
}) => {
  const element = textElement();
  const entry = createMountedElement(
    document,
    createSceneRecord(element),
    [],
    createInstrumentation(),
  );
  const controls = document.createElement("div");
  const button = document.createElement("button");
  button.textContent = "Add row";
  controls.append(button);
  document.body.append(firstPath(entry), controls);
  const canvas = vi.fn(() => false);
  const released = vi.fn();
  const outside = vi.fn(() => handle.dispose());
  const handle = createTextEditingSurface(
    entry.text!,
    element,
    {
      ownsPointerTarget: (target) => target instanceof Node && controls.contains(target),
      onPointerDown: canvas,
      onOutsidePointerDown: outside,
    },
    released,
  );
  onTestFinished(() => {
    handle.dispose();
    controls.remove();
    firstPath(entry).remove();
  });
  const foreignObject = firstPath(entry).querySelector("foreignObject")!;
  const action = vi.fn();
  button.addEventListener("click", action);
  expect(foreignObject.contains(button)).toBe(false);
  const pointer = new PointerEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    clientX: element.x + element.width + 30,
    clientY: element.y,
  });
  button.dispatchEvent(pointer);
  button.click();
  expect(pointer.defaultPrevented).toBe(false);
  expect(action).toHaveBeenCalledOnce();
  expect(canvas).toHaveBeenCalledExactlyOnceWith(pointer);
  expect(outside).not.toHaveBeenCalled();
  expect(released).not.toHaveBeenCalled();
  expect(foreignObject.isConnected).toBe(true);
  handle.container.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  expect(canvas).toHaveBeenCalledTimes(2);
  expect(outside).not.toHaveBeenCalled();
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  expect(canvas).toHaveBeenCalledTimes(3);
  expect(outside).toHaveBeenCalledOnce();
  expect(released).toHaveBeenCalledOnce();
  expect(foreignObject.isConnected).toBe(false);
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  expect(outside).toHaveBeenCalledOnce();
});

it("mounts one runtime editor at its text root and restores static text and listeners", () => {
  const element = textElement();
  const entry = createMountedElement(
    document,
    createSceneRecord(element),
    [],
    createInstrumentation(),
  );
  document.body.append(firstPath(entry));
  const outside = vi.fn();
  const key = vi.fn();
  const released = vi.fn();
  const handle = createTextEditingSurface(
    entry.text!,
    element,
    { onOutsidePointerDown: outside, onKeyDown: key },
    released,
  );
  expect(handle.ownerDocument).not.toBe(document);
  expect(handle.container.ownerDocument).toBe(handle.ownerDocument);
  expect(handle.container.parentElement).toBe(handle.ownerDocument.body);
  const foreignObject = firstPath(entry).querySelector("foreignObject")!;
  expect(foreignObject.parentElement).toBe(firstPath(entry));
  const frame = foreignObject.querySelector("iframe")!;
  expect(firstPath(entry).querySelectorAll("foreignObject")).toHaveLength(1);
  expect(foreignObject.querySelectorAll("iframe")).toHaveLength(1);
  expect(frame.contentDocument).toBe(handle.ownerDocument);
  expect(frame.parentElement?.className).toBe("inkbook-text-editor-viewport");
  const input = handle.ownerDocument.createElement("input");
  handle.container.append(input);
  input.focus();
  expect(handle.ownerDocument.activeElement).toBe(input);
  expect(entry.text!.content.getAttribute("visibility")).toBeNull();
  handle.setReady?.();
  expect(entry.text!.content.getAttribute("visibility")).toBe("hidden");
  expect(firstPath(entry).firstElementChild?.getAttribute("fill")).toBe("#FFAA22FF");
  handle.container.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  handle.container.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  expect(outside).toHaveBeenCalledOnce();
  expect(key).toHaveBeenCalledOnce();
  expect(handle.setContentHeight(300)).toEqual({ minX: 10, maxX: 210, minY: 20, maxY: 320 });
  expect(foreignObject.getAttribute("height")).toBe("300");
  handle.updateBounds({ ...element, width: 300 });
  expect(foreignObject.getAttribute("width")).toBe("300");
  expect(foreignObject.getAttribute("height")).toBe("300");
  handle.setVisibility(false);
  expect(foreignObject.getAttribute("visibility")).toBe("hidden");
  handle.dispose();
  handle.dispose();
  expect(released).toHaveBeenCalledOnce();
  expect(firstPath(entry).querySelector("foreignObject")).toBeNull();
  expect(entry.text!.content.hasAttribute("visibility")).toBe(false);
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  expect(outside).toHaveBeenCalledOnce();
  firstPath(entry).remove();
});
