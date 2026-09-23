import { describe, expect, it } from "vitest";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { normalizeStrokePaint } from "../../../../src/domain/geometry/pressure-paint";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import {
  appendElementToFragment,
  createMountedElement,
  firstPath,
  removeMountedElementNode,
  setMountedElementFade,
  setMountedElementMotion,
  updateMountedGeometry,
  updateMountedPaint,
  updatePreviewTransform,
} from "../../../../src/rendering/scene/mounted-element";
import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";
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

describe("mounted pressure stroke groups", () => {
  it("composites continuous pressure ink once and fades the group", () => {
    const { entry, record, parent } = setup();
    const group = fakeNode(firstPath(entry));
    const opacity = normalizeStrokePaint(record.element.style).opacity;
    expect(group.tagName).toBe("g");
    expect(group.parent).toBe(parent);
    expect(group.attributes.get("opacity")).toBe(String(opacity));
    expect(group.nodes).toHaveLength(1);
    for (const path of group.nodes) {
      expect(path.attributes.get("fill")).toBe("#123456FF");
      expect(path.attributes.get("fill-opacity")).toBe("1");
    }
    setMountedElementMotion(entry, 0.5, 1.2);
    expect(group.style.opacity).toBe(String(Math.round(opacity * 0.5 * 10000) / 10000));
    expect(group.nodes.every((node) => node.style.opacity === undefined)).toBe(true);
    setMountedElementMotion(entry, null);
    expect(group.style.opacity).toBeUndefined();
    setMountedElementFade(entry, 100);
    expect(entry.fadeActive).toBe(true);
    expect(group.style.opacity).toBe("");
    expect(group.attributes.get("opacity")).toBe(String(opacity));
    expect(group.style.filter).toBe("blur(12.5px)");
    expect(group.style.animation).toBe(
      "inkbook-element-erase 100ms cubic-bezier(0.645, 0.045, 0.355, 1) forwards",
    );
    expect(group.nodes.every((node) => node.style.filter === undefined)).toBe(true);
    setMountedElementFade(entry, null);
    expect(entry.fadeActive).toBe(false);
    expect(group.style.opacity).toBe("");
    expect(group.style.filter).toBe("");
    expect(group.style.animation).toBe("");
    expect(removeMountedElementNode(entry)).toBe(true);
    expect(parent.nodes).toHaveLength(0);
  });

  it("writes one group transform per movement without adding stroke presentation to the outline", () => {
    const { entry, instrumentation } = setup();
    updatePreviewTransform(entry, "scale(2 3)", 1, 2, instrumentation);
    const paths = entry.paths.map((path) => fakeNode(path.node));
    expect(paths.every((path) => !path.attributes.has("vector-effect"))).toBe(true);
    const before = instrumentation.attributeWrites;
    updatePreviewTransform(entry, "scale(3 4)", 2, 2, instrumentation);
    expect(instrumentation.attributeWrites - before).toBe(1);
    expect(paths.every((path) => !path.attributes.has("transform"))).toBe(true);
    updatePreviewTransform(entry, null, 3, null, instrumentation);
    expect(paths.every((path) => !path.attributes.has("vector-effect"))).toBe(true);
  });

  it("preserves group transform when continuous outline geometry changes", () => {
    const { entry, record, parent, ownerDocument, instrumentation } = setup();
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
    expect(parent.nodes).toHaveLength(1);
    expect(fakeNode(firstPath(entry)).attributes.get("transform")).toBe("scale(2 3)");
    expect(entry.paths).toHaveLength(1);
    expect(fakeNode(entry.paths[0]!.node).attributes.get("d")).toBe(parts[0]!.d);
    expect(fakeNode(entry.paths[0]!.node).attributes.has("stroke-width")).toBe(false);
  });

  it("switches between flat constant-width ink and grouped pressure ink in place", () => {
    const { entry, record, parent, ownerDocument, instrumentation } = setup(false);
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
    expect(parent.nodes).toHaveLength(1);
    expect(fakeNode(firstPath(entry)).tagName).toBe("g");
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
  });
});

describe("mounted pressure paint", () => {
  it("updates group alpha when stroke paint changes", () => {
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

describe("width-dependent erase blur", () => {
  it.each([
    [true, 2, "pen", 12.5],
    [false, 2, "pen", 12.5],
    [true, 4, "pen", 25],
    [true, 8, "pen", 50],
    [false, 22, "pen", 50],
    [false, 2, "highlighter", 31.25],
  ] as const)("scales blur for pressure=%s width=%s tool=%s", (pressure, width, tool, radius) => {
    const { entry } = setup(pressure, width, tool);
    setMountedElementFade(entry, 400);
    expect(fakeNode(firstPath(entry)).style.filter).toBe(`blur(${String(radius)}px)`);
    setMountedElementFade(entry, null);
    expect(fakeNode(firstPath(entry)).style.filter).toBe("");
    setMountedElementFade(entry, 0);
    expect(fakeNode(firstPath(entry)).style.filter).toBe("");
    expect(fakeNode(firstPath(entry)).style.opacity).toBe("0");
  });

  it("preserves full blur for filled shapes", () => {
    const record = fakeRectangleRecord("filled", 0, 0);
    if (!("fillColor" in record.element.style)) throw new Error("Expected closed shape");
    record.element.style.fillColor = { type: "rgba", value: "#123456FF" };
    const entry = createMountedElement(
      new FakeDocument() as unknown as Document,
      record,
      buildElementPathParts(record.element),
      createInstrumentation(),
    );
    setMountedElementFade(entry, 400);
    expect(fakeNode(firstPath(entry)).style.filter).toBe("blur(50px)");
  });
});
