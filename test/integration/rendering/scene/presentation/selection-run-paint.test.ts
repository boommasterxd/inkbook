import { expect, it } from "vitest";
import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import {
  createMountedElement,
  updateMountedGeometry,
  updatePreviewTransform,
} from "../../../../../src/rendering/scene/content/mounted-element";
import { createInstrumentation } from "../../../../../src/rendering/scene/instrumentation";
import {
  createMultiWindowPressureStroke,
  createTestStroke,
} from "../../../../fixtures/persistence/worker-snapshot";
import { createSceneRecord } from "../../../../fixtures/rendering/scene";
import {
  ACTIVE,
  DASH,
  fixture,
  NS,
  palette,
  WIDTH,
} from "../../../../fixtures/rendering/selection-run-paint";
import { fakeRectangleRecord } from "../../../../unit/rendering/scene/fakes";

it("keeps idle attributes/styles native and all zoom work strictly idle", () => {
  const f = fixture();
  const entry = f.mount();
  const node = entry.paths[0]!.node;
  const presentation = { ...entry.paths[0]!.appliedPresentation };
  const native = node.getAttribute("stroke-width");
  const existingPaint = node.style;
  existingPaint.setProperty("stroke-width", "7px", "important");
  f.width.prepare(entry);
  expect(node.getAttribute("stroke-width")).toBe(native);
  expect(node.getAttribute("vector-effect")).toBeNull();
  expect(node.style.getPropertyValue("stroke-width")).toBe("7px");
  expect(node.style.getPropertyPriority("stroke-width")).toBe("important");
  expect(node.style.getPropertyValue("vector-effect")).toBe("");
  expect(entry.paths[0]!.appliedPresentation).toEqual(presentation);
  expect(f.group.hasAttribute(ACTIVE)).toBe(false);
  expect(f.svg.getAttribute("style")).toBeNull();
  const writes = f.instrumentation.attributeWrites;
  f.readZoom.mockClear();
  f.setZoom(0.5);
  f.width.refreshZoom();
  f.width.prepare(entry);
  expect(f.instrumentation.attributeWrites).toBe(writes);
  expect(f.readZoom).not.toHaveBeenCalled();
  f.width.release(entry);
  expect(node.hasAttribute(WIDTH)).toBe(false);
  expect(node.getAttribute("stroke-width")).toBe(native);
  expect(node.style.getPropertyValue("stroke-width")).toBe("7px");
});

it("matches canonical rounded paint at every validated width/dash and highlighter width", () => {
  const f = fixture();
  const entries = [];
  for (const outlineWidth of [1, 2, 4, 8, 12, 14, 22] as const) {
    for (const outlineStyle of ["dashed", "dotted"] as const) {
      const record = fakeRectangleRecord(`${outlineWidth}-${outlineStyle}`, 0, 0);
      if (record.element.kind !== "rectangle") throw Error("Expected rectangle.");
      entries.push(
        f.mount({
          ...record,
          element: {
            ...record.element,
            style: { ...record.element.style, outlineWidth, outlineStyle },
          },
        }),
      );
    }
  }
  for (const width of [2, 4, 8, 14, 22] as const) {
    const source = createTestStroke();
    entries.push(
      f.mount(
        createSceneRecord({
          ...source,
          id: `highlight-${width}`,
          tool: "highlighter",
          style: {
            ...source.style,
            width,
            pressureEnabled: false,
            opacity: 0.4,
          },
        }),
      ),
    );
  }
  for (const entry of entries) f.width.prepare(entry);
  f.width.setActive(f.group, true);
  const sheetText = f.svg.querySelector("style")!.textContent;
  for (const zoom of [0.5, 1.333333333, 2]) {
    f.setZoom(zoom);
    const before = f.instrumentation.attributeWrites;
    f.width.refreshZoom();
    expect(f.instrumentation.attributeWrites - before).toBeLessThanOrEqual(26);
    for (const entry of entries) {
      const reference = createMountedElement(
        f.document,
        {
          id: entry.id,
          element: entry.displayedElement,
          rank: entry.rank,
          band: entry.band,
        } as never,
        buildElementPathParts(entry.displayedElement),
        createInstrumentation(),
      );
      updatePreviewTransform(reference, "scale(3 3)", zoom, zoom, createInstrumentation());
      const node = entry.paths[0]!.node;
      expect(palette(f.group, node, "width")).toBe(
        reference.paths[0]!.node.getAttribute("stroke-width"),
      );
      if (node.hasAttribute(DASH))
        expect(palette(f.group, node, "dash")).toBe(
          reference.paths[0]!.node.getAttribute("stroke-dasharray"),
        );
    }
    expect(f.svg.querySelector("style")!.textContent).toBe(sheetText);
    const writes = f.instrumentation.attributeWrites;
    f.width.refreshZoom();
    f.width.setActive(f.group, true);
    expect(f.instrumentation.attributeWrites).toBe(writes);
  }
  expect(f.width.memoryUsage()).toMatchObject({
    widthPaletteEntries: 12,
    dashPaletteEntries: 14,
    paletteOverrides: 26,
  });
  f.width.setActive(f.group, false);
  expect(f.group.hasAttribute(ACTIVE)).toBe(false);
  expect(f.group.style.length).toBe(0);
  expect(f.svg.getAttribute("style")).toBeNull();
});

it("preserves multipart pressure opacity and releases slots across mounted topology changes", () => {
  const f = fixture();
  const source = createMultiWindowPressureStroke();
  const pressureRecord = createSceneRecord({
    ...source,
    style: { ...source.style, opacity: 0.4 },
  });
  const segments = [source.points.slice(0, 96 * 3), source.points.slice(95 * 3)];
  const parts = segments.flatMap((points) =>
    buildElementPathParts({
      ...pressureRecord.element,
      points,
    } as typeof source),
  );
  const pressure = createMountedElement(f.document, pressureRecord, parts, f.instrumentation);
  f.group.append(pressure.group!);
  expect(pressure.paths.length).toBeGreaterThan(1);
  const snapshot = pressure.group!.outerHTML;
  const writes = f.instrumentation.attributeWrites;
  f.width.prepare(pressure);
  f.width.setActive(f.group, true);
  expect(pressure.group!.outerHTML).toBe(snapshot);
  expect(f.instrumentation.attributeWrites - writes).toBe(1);
  f.width.setActive(f.group, false);
  const shape = fakeRectangleRecord(pressure.id, 0, 0);
  updateMountedGeometry(
    pressure,
    shape,
    buildElementPathParts(shape.element),
    f.document,
    f.group,
    f.instrumentation,
  );
  f.width.prepare(pressure);
  const oldNode = pressure.paths[0]!.node;
  expect(oldNode.hasAttribute(WIDTH)).toBe(true);
  updateMountedGeometry(
    pressure,
    pressureRecord,
    buildElementPathParts(pressureRecord.element),
    f.document,
    f.group,
    f.instrumentation,
  );
  f.width.prepare(pressure);
  expect(oldNode.hasAttribute(WIDTH)).toBe(false);
  expect(pressure.paths.every((path) => !path.node.hasAttribute(WIDTH))).toBe(true);
  expect(f.width.memoryUsage().trackedPaths).toBe(0);
});

it("restores captured slot attributes and container priorities without touching mounted paint", () => {
  const f = fixture();
  const entry = f.mount();
  const node = entry.paths[0]!.node;
  node.setAttribute(WIDTH, "original-width");
  node.setAttribute(DASH, "original-dash");
  const existingPaint = f.group.style;
  existingPaint.setProperty("--inkbook-run-width-0", "9", "important");
  f.width.prepare(entry);
  f.width.setActive(f.group, true);
  f.width.setActive(f.group, false);
  f.width.release(entry);
  expect(node.getAttribute(WIDTH)).toBe("original-width");
  expect(node.getAttribute(DASH)).toBe("original-dash");
  expect(f.group.style.getPropertyValue("--inkbook-run-width-0")).toBe("9");
  expect(f.group.style.getPropertyPriority("--inkbook-run-width-0")).toBe("important");
  expect(node.style.length).toBe(0);
});

it("keeps prefix/suffix palettes local through activation, late preparation and reuse", () => {
  const f = fixture();
  const second = f.document.createElementNS(NS, "g");
  f.svg.append(second);
  f.width.setActive(f.group, true);
  const entry = f.mount();
  f.width.prepare(entry);
  f.width.setActive(second, true);
  const node = entry.paths[0]!.node;
  expect(palette(f.group, node, "width")).toBe("4");
  expect(palette(second, node, "width")).toBe("4");
  f.width.setActive(f.group, false);
  f.setZoom(0.5);
  const writes = f.instrumentation.attributeWrites;
  f.width.refreshZoom();
  expect(f.instrumentation.attributeWrites - writes).toBe(1);
  expect(f.group.style.length).toBe(0);
  expect(palette(second, node, "width")).toBe("1");
  f.width.setActive(second, false);
  f.width.setActive(f.group, true);
  expect(palette(f.group, node, "width")).toBe("1");
  expect(second.style.length).toBe(0);
  expect(f.svg.getAttribute("style")).toBeNull();
});

it.each(["pen", "straight-highlighter"] as const)(
  "matches canonical %s widths across all validated tool sizes and zooms",
  (kind) => {
    const f = fixture();
    const entries = ([2, 4, 8, 14, 22] as const).map((width) => {
      const source = createTestStroke();
      const style = {
        ...source.style,
        width,
        pressureEnabled: false,
        opacity: 0.4,
      };
      const element: import("../../../../../src/domain/schema/public").InkElementV1 =
        kind === "pen"
          ? { ...source, id: `pen-${width}`, tool: "pen", style }
          : {
              id: `straight-${width}`,
              createdAt: source.createdAt,
              pivot: source.pivot,
              rotation: 0,
              kind,
              start: { x: 0, y: 0 },
              end: { x: 100, y: 100 },
              bend: null,
              startNode: "none",
              endNode: "none",
              style,
            };
      const record = createSceneRecord(element);
      const entry = f.mount(record);
      const reference = createMountedElement(
        f.document,
        record,
        buildElementPathParts(element),
        createInstrumentation(),
      );
      f.width.prepare(entry);
      return { entry, reference };
    });
    f.width.setActive(f.group, true);
    for (const zoom of [0.5, 2]) {
      f.setZoom(zoom);
      f.width.refreshZoom();
      for (const { entry, reference } of entries) {
        updatePreviewTransform(reference, "scale(3 3)", zoom, zoom, createInstrumentation());
        expect(palette(f.group, entry.paths[0]!.node, "width")).toBe(
          reference.paths[0]!.node.getAttribute("stroke-width"),
        );
        expect(entry.paths[0]!.node.getAttribute("stroke-opacity")).toBe("0.4");
        expect(entry.paths[0]!.node.getAttribute("fill")).toBe("none");
      }
    }
    f.width.setActive(f.group, false);
    for (const { entry } of entries) f.width.release(entry);
    expect(f.width.memoryUsage().trackedEntries).toBe(0);
  },
);
