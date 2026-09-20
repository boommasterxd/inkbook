import { describe, expect, it } from "vitest";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { normalizeStrokePaint } from "../../../../src/domain/geometry/pressure-paint";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import {
  appendElementToFragment,
  createMountedElement,
  firstPath,
  removeMountedElement,
  setMountedElementFade,
  setMountedElementMotion,
  updateMountedGeometry,
  updateMountedPaint,
  updatePreviewTransform,
} from "../../../../src/rendering/scene/mounted-element";
import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";
import { FakeDocument, FakeNode, fakeNode, fakeRectangleRecord } from "./fakes";

function setup(pressureEnabled = true) {
  const source = createTestStroke();
  const element = {
    ...source,
    points: [0, 0, 0, 20, 20, 1, 40, 0, 0],
    style: {
      ...source.style,
      pressureEnabled,
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
    expect(group.style.opacity).toBe("0");
    expect(group.style.filter).toBe("blur(50px)");
    expect(group.style.transition).toBe(
      "opacity 100ms cubic-bezier(0.3, 0, 0.7, 1), filter 100ms cubic-bezier(0.3, 0, 0.7, 1)",
    );
    expect(group.nodes.every((node) => node.style.filter === undefined)).toBe(true);
    setMountedElementFade(entry, null);
    expect(group.style.opacity).toBe("");
    expect(group.style.filter).toBe("");
    expect(group.style.transition).toBe("");
    removeMountedElement(entry);
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
