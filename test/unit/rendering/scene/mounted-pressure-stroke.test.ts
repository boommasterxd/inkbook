import { describe, expect, it, vi } from "vitest";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { normalizeStrokePaint } from "../../../../src/domain/geometry/pressure/pressure-paint";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import {
  appendElementToFragment,
  createMountedElement,
  firstPath,
  removeMountedElementNode,
  setMountedElementFade,
  setMountedElementMotion,
  updateMountedGeometry,
  updateMountedElementPreview,
  updateMountedPaint,
  updatePreviewTransform,
} from "../../../../src/rendering/scene/content/mounted-element";
import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";
import { activeFade } from "../../../fixtures/rendering/scene-fades";
import { FakeDocument, FakeNode, fakeNode, fakeRectangleRecord } from "./fakes";

function setup(
  pressureEnabled = true,
  width: 2 | 4 | 8 | 14 | 22 = 2,
  tool: "pen" | "highlighter" = "pen",
) {
  const source = createTestStroke();
  const element = {
    ...source,
    tool,
    points: [0, 0, 0, 20, 20, 1, 40, 0, 0],
    style: {
      ...source.style,
      pressureEnabled,
      width,
      opacity: 0.7,
      color: { type: "rgba" as const, value: "#12345680" as const },
    },
  };
  const record = { ...fakeRectangleRecord(source.id, 0, 0), element };
  const document = new FakeDocument();
  const ownerDocument = document as unknown as Document;
  const parent = new FakeNode(document, "g");
  const instrumentation = createInstrumentation();
  const parts = buildElementPathParts(element);
  const entry = createMountedElement(ownerDocument, record, parts, instrumentation);
  const createFragment = document.createDocumentFragment.bind(document);
  const fragment = createFragment();
  appendElementToFragment(entry, fragment as unknown as DocumentFragment);
  parent.append(fragment);
  return { entry, instrumentation, ownerDocument, parent, parts, record };
}

function expectSameMountedStrokeRoot(
  entry: ReturnType<typeof setup>["entry"],
  parent: ReturnType<typeof setup>["parent"],
  original: ReturnType<typeof firstPath>,
) {
  expect(parent.nodes).toHaveLength(1);
  expect(firstPath(entry)).toBe(original);
}

function observeFilterWrites(node: FakeNode) {
  let filter = node.style.filter;
  const writeFilter = vi.fn((value: string) => {
    filter = value;
  });
  Object.defineProperty(node.style, "filter", { get: () => filter, set: writeFilter });
  return writeFilter;
}

function createFilledShapeEntry() {
  const record = fakeRectangleRecord("filled", 0, 0);
  if (!("fillColor" in record.element.style)) throw new Error("Expected closed shape");
  record.element.style.fillColor = { type: "rgba", value: "#123456FF" };
  return createMountedElement(
    new FakeDocument() as unknown as Document,
    record,
    buildElementPathParts(record.element),
    createInstrumentation(),
  );
}

function setupOpacityFade(kind: "pressure" | "flat" | "highlighter" | "straight-highlighter") {
  const fixture = setup(
    kind === "pressure",
    2,
    kind.includes("highlighter") ? "highlighter" : "pen",
  );
  if (kind !== "straight-highlighter") return fixture;
  const { createdAt, id, pivot, rotation, style } = fixture.record.element;
  const record = {
    ...fixture.record,
    element: {
      kind: "straight-highlighter" as const,
      createdAt,
      id,
      pivot,
      rotation,
      style,
      start: { x: 0, y: 0 },
      end: { x: 40, y: 0 },
      bend: null,
      startNode: "none" as const,
      endNode: "none" as const,
    },
  };
  const entry = createMountedElement(
    fixture.ownerDocument,
    record,
    buildElementPathParts(record.element),
    fixture.instrumentation,
  );
  return { ...fixture, entry, record };
}

describe("mounted pressure stroke roots", () => {
  it("composites continuous pressure ink once and fades its fill paint", () => {
    const { entry, record, parent } = setup();
    const path = fakeNode(firstPath(entry));
    const opacity = normalizeStrokePaint(record.element.style).opacity;
    expect(entry.group).toBeNull();
    expect(path.parent).toBe(parent);
    expect(path.attributes.get("opacity")).toBe(String(opacity));
    expect(path.attributes.get("fill")).toBe("#123456FF");
    expect(path.attributes.get("fill-opacity")).toBe("1");
    setMountedElementMotion(entry, 0.5, 1.2);
    expect(path.style.opacity).toBe(String(Math.round(opacity * 0.5 * 10000) / 10000));
    setMountedElementMotion(entry, null);
    expect(path.style.opacity).toBeUndefined();
    setMountedElementFade(entry, 100);
    expect(entry.fadeActive).toBe(true);
    expect(path.style.opacity).toBeUndefined();
    expect(path.attributes.get("opacity")).toBe(String(opacity));
    expect(path.style.filter).toBeUndefined();
    expect(activeFade(path).keyframes.fillOpacity).toEqual(["1", "0"]);
    expect(activeFade(path).options.duration).toBe(100);
    setMountedElementFade(entry, null);
    expect(entry.fadeActive).toBe(false);
    expect(path.style.opacity).toBeUndefined();
    expect(path.style.filter).toBeUndefined();
    expect(path.getAnimations()).toHaveLength(0);
    expect(removeMountedElementNode(entry)).toBe(true);
    expect(parent.nodes).toHaveLength(0);
  });

  it("writes one root transform per movement without adding stroke presentation to the outline", () => {
    const { entry, instrumentation } = setup();
    updatePreviewTransform(entry, "scale(2 3)", 1, 2, instrumentation);
    const paths = entry.paths.map((path) => fakeNode(path.node));
    expect(paths.every((path) => !path.attributes.has("vector-effect"))).toBe(true);
    const before = instrumentation.attributeWrites;
    updatePreviewTransform(entry, "scale(3 4)", 2, 2, instrumentation);
    expect(instrumentation.attributeWrites - before).toBe(1);
    expect(paths[0]!.attributes.get("transform")).toBe("scale(3 4)");
    updatePreviewTransform(entry, null, 3, null, instrumentation);
    expect(paths.every((path) => !path.attributes.has("vector-effect"))).toBe(true);
  });

  it("preserves root transform and identity when continuous outline geometry changes", () => {
    const { entry, record, parent, ownerDocument, instrumentation } = setup();
    const original = firstPath(entry);
    updatePreviewTransform(entry, "scale(2 3)", 1, 2, instrumentation);
    const next = { ...record, element: { ...record.element, points: [0, 0, 0.5, 30, 30, 0.5] } };
    const parts = buildElementPathParts(next.element);
    updateMountedGeometry(
      entry,
      next,
      parts,
      ownerDocument,
      parent as unknown as SVGGElement,
      instrumentation,
    );
    expectSameMountedStrokeRoot(entry, parent, original);
    expect(fakeNode(firstPath(entry)).attributes.get("transform")).toBe("scale(2 3)");
    expect(entry.paths).toHaveLength(1);
    expect(fakeNode(entry.paths[0]!.node).attributes.get("d")).toBe(parts[0]!.d);
    expect(fakeNode(entry.paths[0]!.node).attributes.has("stroke-width")).toBe(false);
  });

  it("switches between flat constant-width and pressure ink without replacing its single root", () => {
    const { entry, record, parent, ownerDocument, instrumentation } = setup(false);
    const original = firstPath(entry);
    const next = {
      ...record,
      element: { ...record.element, style: { ...record.element.style, pressureEnabled: true } },
    };
    updateMountedGeometry(
      entry,
      next,
      buildElementPathParts(next.element),
      ownerDocument,
      parent as unknown as SVGGElement,
      instrumentation,
    );
    expectSameMountedStrokeRoot(entry, parent, original);
    expect(fakeNode(firstPath(entry)).attributes.get("opacity")).toBe(
      String(normalizeStrokePaint(next.element.style).opacity),
    );
    updateMountedGeometry(
      entry,
      record,
      buildElementPathParts(record.element),
      ownerDocument,
      parent as unknown as SVGGElement,
      instrumentation,
    );
    expect(parent.nodes).toHaveLength(1);
    expect(fakeNode(firstPath(entry)).tagName).toBe("path");
    expect(fakeNode(firstPath(entry)).attributes.has("opacity")).toBe(false);
  });
});

it("preserves alpha and preview placement across single and multipart pressure geometry", () => {
  const { entry, record, parts, parent, ownerDocument, instrumentation } = setup();
  const pointCount = record.element.points.length;
  const opacity = normalizeStrokePaint(record.element.style).opacity;
  updatePreviewTransform(entry, "translate(12 9)", 1, null, instrumentation);
  for (const next of [[parts[0]!, parts[0]!], parts]) {
    updateMountedGeometry(
      entry,
      record,
      next,
      ownerDocument,
      parent as unknown as SVGGElement,
      instrumentation,
    );
    const root = fakeNode(firstPath(entry));
    expect(parent.nodes).toEqual([root]);
    expect(root.attributes.get("opacity")).toBe(String(opacity));
    expect(root.attributes.get("transform")).toBe("translate(12 9)");
    expect(entry.paths.map(({ node }) => fakeNode(node).attributes.get("d"))).toEqual(
      next.map(({ d }) => d),
    );
    expect(entry.group !== null).toBe(next.length > 1);
    expect(record.element.points).toHaveLength(pointCount);
  }
});

describe("mounted pressure paint", () => {
  it("updates root alpha when stroke paint changes without rebuilding geometry", () => {
    const { entry, record, parts, instrumentation } = setup();
    const next = {
      ...record,
      element: { ...record.element, style: { ...record.element.style, opacity: 0.2 } },
    };
    updateMountedPaint(entry, next, parts, instrumentation);
    expect(fakeNode(firstPath(entry)).attributes.get("opacity")).toBe(
      String(normalizeStrokePaint(next.element.style).opacity),
    );
  });
});

it.each(["commit", "preview"] as const)(
  "clears old fade and motion channels through %s updates that toggle pressure",
  (mode) => {
    const { entry, record, ownerDocument, parent, instrumentation } = setup(false);
    const original = firstPath(entry);
    const path = fakeNode(original);
    for (const pressureEnabled of [true, false]) {
      setMountedElementFade(entry, 100);
      setMountedElementMotion(entry, 0.5, 1.2);
      const next = {
        ...record,
        element: { ...record.element, style: { ...record.element.style, pressureEnabled } },
      };
      const parts = buildElementPathParts(next.element);
      if (mode === "commit") {
        updateMountedGeometry(
          entry,
          next,
          parts,
          ownerDocument,
          parent as unknown as SVGGElement,
          instrumentation,
        );
      } else {
        updateMountedElementPreview(entry, record, next.element, parts, {
          ownerDocument,
          parent: parent as unknown as SVGGElement,
          instrumentation,
        });
      }
      expect(firstPath(entry)).toBe(original);
      expect(path.getAnimations()).toHaveLength(0);
      expect(entry.fadeActive).toBe(false);
      expect(entry.motionActive).toBe(false);
      expect(path.style.getPropertyValue("fill-opacity")).toBe("");
      expect(path.style.getPropertyValue("opacity")).toBe("");
      expect(path.style.getPropertyValue("transform")).toBe("");
      expect(path.attributes.get("opacity")).toBe(
        pressureEnabled ? String(normalizeStrokePaint(next.element.style).opacity) : undefined,
      );
      expect(path.attributes.get("d")).toBe(parts[0]!.d);
    }
  },
);

it.each(["kind", "pressure-style"] as const)(
  "cancels original pressure-paint feedback after the displayed %s changes",
  (change) => {
    const { entry, record } = setup();
    const path = fakeNode(entry.paths[0]!.node);
    const originalOpacity = path.attributes.get("opacity");
    const writePathFilter = observeFilterWrites(path);
    setMountedElementMotion(entry, 0.5, 1.2);
    const motionOpacity = path.style.opacity;
    const motionTransform = path.style.transform;
    setMountedElementFade(entry, 400);
    expect(activeFade(path as unknown as Element).keyframes.fillOpacity).toEqual(["1", "0"]);
    entry.displayedElement =
      change === "kind"
        ? fakeRectangleRecord(record.id, 0, 0).element
        : { ...record.element, style: { ...record.element.style, pressureEnabled: false } };
    setMountedElementFade(entry, null);
    expect(entry.fadeActive).toBe(false);
    expect(path.getAnimations()).toHaveLength(0);
    expect(path.style.getPropertyValue("fill-opacity")).toBe("");
    expect(path.style.opacity).toBe(motionOpacity);
    expect(path.style.transform).toBe(motionTransform);
    expect(path.attributes.get("opacity")).toBe(originalOpacity);
    expect(writePathFilter).not.toHaveBeenCalled();
  },
);

it("fades multipart pressure at the group to preserve overlapping-path compositing", () => {
  const { ownerDocument, record, parts, instrumentation } = setup();
  const entry = createMountedElement(
    ownerDocument,
    record,
    [parts[0]!, parts[0]!],
    instrumentation,
  );
  const group = fakeNode(entry.group!);
  const opacity = normalizeStrokePaint(record.element.style).opacity;
  expect(group.nodes).toHaveLength(2);
  expect(group.attributes.get("opacity")).toBe(String(opacity));
  const writeFilter = observeFilterWrites(group);
  const childrenUnchanged = () =>
    group.nodes.every(
      (path) =>
        path.getAnimations().length === 0 &&
        path.style.opacity === undefined &&
        path.style.filter === undefined,
    );
  setMountedElementFade(entry, 400);
  expect(activeFade(group as unknown as Element).keyframes.opacity).toEqual([String(opacity), "0"]);
  expect(activeFade(group as unknown as Element).options.duration).toBe(400);
  expect(group.attributes.get("opacity")).toBe(String(opacity));
  expect(childrenUnchanged()).toBe(true);
  setMountedElementFade(entry, null);
  expect(entry.fadeActive).toBe(false);
  expect(group.getAnimations()).toHaveLength(0);
  expect(group.style.getPropertyValue("opacity")).toBe("");
  expect(group.attributes.get("opacity")).toBe(String(opacity));
  expect(childrenUnchanged()).toBe(true);
  expect(writeFilter).not.toHaveBeenCalled();
});

describe("opacity-only removal feedback", () => {
  it.each(["pressure", "flat", "highlighter", "straight-highlighter"] as const)(
    "fades original %s paint without changing its alpha or group compositing",
    (kind) => {
      const { entry, record } = setupOpacityFade(kind);
      const node = fakeNode(entry.paths[0]!.node);
      const group = entry.group === null ? undefined : fakeNode(entry.group);
      const originalGroupOpacity = group?.attributes.get("opacity");
      const writeFilter = observeFilterWrites(node);
      const attribute = kind === "pressure" ? "fill-opacity" : "stroke-opacity";
      const opacity = node.attributes.get(attribute);
      expect(opacity).toBe(kind === "pressure" ? "1" : String(record.element.style.opacity));
      setMountedElementFade(entry, 400);
      expect(entry.fadeActive).toBe(true);
      const frames = activeFade(node).keyframes;
      expect(kind === "pressure" ? frames.fillOpacity : frames.opacity).toEqual(["1", "0"]);
      expect(activeFade(node).options.duration).toBe(400);
      expect(node.style.filter || "").toBe("");
      expect(node.style.getPropertyValue("opacity")).toBe("");
      expect(node.attributes.get(attribute)).toBe(opacity);
      expect(group?.attributes.get("opacity")).toBe(originalGroupOpacity);
      if (group !== undefined) {
        expect(originalGroupOpacity).toBe(
          String(normalizeStrokePaint(record.element.style).opacity),
        );
        expect(group.getAnimations()).toHaveLength(0);
        expect(group.style.getPropertyValue("opacity")).toBe("");
      }
      setMountedElementFade(entry, null);
      expect(entry.fadeActive).toBe(false);
      expect(node.getAnimations()).toHaveLength(0);
      expect(node.style.filter || "").toBe("");
      expect(node.style.getPropertyValue("opacity")).toBe("");
      setMountedElementFade(entry, 0);
      expect(node.getAnimations()).toHaveLength(0);
      expect(node.style.filter || "").toBe("");
      expect(node.style.getPropertyValue(kind === "pressure" ? "fill-opacity" : "opacity")).toBe(
        "0",
      );
      expect(node.attributes.get(attribute)).toBe(opacity);
      expect(group?.attributes.get("opacity")).toBe(originalGroupOpacity);
      expect(group?.style.getPropertyValue("opacity") || "").toBe("");
      setMountedElementFade(entry, null);
      expect(node.style.getPropertyValue("opacity")).toBe("");
      expect(writeFilter).not.toHaveBeenCalled();
    },
  );

  it("clears the original fill fade before restarting on a changed element kind", () => {
    const { entry, record } = setup();
    const path = fakeNode(entry.paths[0]!.node);
    const rootOpacity = path.attributes.get("opacity");
    setMountedElementFade(entry, 400);
    entry.displayedElement = fakeRectangleRecord(record.id, 0, 0).element;
    setMountedElementFade(entry, 200);
    expect(path.getAnimations()).toHaveLength(1);
    expect(activeFade(path).keyframes.fillOpacity).toBeUndefined();
    expect(activeFade(path).keyframes.opacity).toEqual([rootOpacity, "0"]);
    expect(activeFade(path).options.duration).toBe(200);
    expect(path.attributes.get("opacity")).toBe(rootOpacity);
    expect(path.style.filter).toBeUndefined();
    setMountedElementFade(entry, null);
    expect(path.getAnimations()).toHaveLength(0);
    expect(path.style.getPropertyValue("opacity")).toBe("");
    expect(path.style.getPropertyValue("fill-opacity")).toBe("");
  });

  it("fades filled shapes from their original root opacity without filter writes", () => {
    const entry = createFilledShapeEntry();
    const node = fakeNode(firstPath(entry));
    const writeFilter = observeFilterWrites(node);
    const paint = [...node.attributes];
    setMountedElementFade(entry, 400);
    expect(node.style.filter).toBeUndefined();
    expect(activeFade(node).options.duration).toBe(400);
    expect(node.style.getPropertyValue("opacity")).toBe("");
    expect([...node.attributes]).toEqual(paint);
    setMountedElementFade(entry, null);
    expect(node.getAnimations()).toHaveLength(0);
    setMountedElementFade(entry, 0);
    expect(node.getAnimations()).toHaveLength(0);
    expect(node.style.opacity).toBe("0");
    setMountedElementFade(entry, null);
    expect(node.style.getPropertyValue("opacity")).toBe("");
    expect([...node.attributes]).toEqual(paint);
    expect(writeFilter).not.toHaveBeenCalled();
  });
});
