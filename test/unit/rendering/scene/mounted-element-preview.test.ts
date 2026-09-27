import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";
import { createSceneRecord } from "../../../fixtures/rendering/scene";
import { strokeLocalGeometry } from "../../../../src/domain/geometry/stroke-position";
import { describe, expect, it } from "vitest";

import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import {
  createMountedElement,
  firstPath,
  updatePreviewTransform,
  updateMountedGeometry,
} from "../../../../src/rendering/scene/mounted-element";

import { FakeDocument, FakeNode, fakeNode, fakeRectangleRecord } from "./fakes";

describe("mounted element transform previews", () => {
  it.each(["dashed", "dotted"] as const)(
    "preserves %s pattern spacing across camera zoom and preview cleanup",
    (outlineStyle) => {
      const base = fakeRectangleRecord("shape", 0, 10);
      if (base.element.kind !== "rectangle") throw new Error("Expected a rectangle.");
      const record = {
        ...base,
        element: { ...base.element, style: { ...base.element.style, outlineStyle } },
      };
      const instrumentation = createInstrumentation();
      const entry = createMountedElement(
        new FakeDocument() as unknown as Document,
        record,
        buildElementPathParts(record.element),
        instrumentation,
      );
      const path = fakeNode(firstPath(entry));
      const original = path.attributes.get("stroke-dasharray")!;
      for (const zoom of [0.5, 2]) {
        updatePreviewTransform(entry, "scale(3 0.5)", 1, zoom, instrumentation);
        expect(path.attributes.get("stroke-dasharray")).toBe(
          original
            .split(" ")
            .map((value) => Number(value) * zoom)
            .join(" "),
        );
      }
      updatePreviewTransform(entry, null, 2, null, instrumentation);
      expect(path.attributes.get("stroke-dasharray")).toBe(original);
    },
  );

  it("preserves visible stroke width at the supplied camera scale", () => {
    const record = fakeRectangleRecord("shape", 0, 10);
    const instrumentation = createInstrumentation();
    const entry = createMountedElement(
      new FakeDocument() as unknown as Document,
      record,
      buildElementPathParts(record.element),
      instrumentation,
    );
    const path = fakeNode(firstPath(entry));

    updatePreviewTransform(entry, "scale(3 0.5)", 1, 2, instrumentation);
    expect(path.attributes.get("transform")).toBe("scale(3 0.5)");
    expect(path.attributes.get("vector-effect")).toBe("non-scaling-stroke");
    expect(path.attributes.get("stroke-width")).toBe("4");

    updatePreviewTransform(entry, "scale(0.25 5)", 2, 0.5, instrumentation);
    expect(path.attributes.get("stroke-width")).toBe("1");

    updatePreviewTransform(entry, null, 3, null, instrumentation);
    expect(path.attributes.has("vector-effect")).toBe(false);
    expect(path.attributes.get("stroke-width")).toBe("2");
  });
});

it.each([false, true])(
  "composes durable stroke position with previews (pressure: %s)",
  (pressureEnabled) => {
    const source = createTestStroke();
    const element = {
      ...source,
      offset: { x: 30, y: 40 },
      style: { ...source.style, pressureEnabled },
    };
    const record = createSceneRecord(element);
    const doc = new FakeDocument() as unknown as Document;
    const instrumentation = createInstrumentation();
    const parts = buildElementPathParts(strokeLocalGeometry(element));
    const entry = createMountedElement(doc, record, parts, instrumentation);
    const node = fakeNode(firstPath(entry));
    expect(node.attributes.get("transform")).toBe("translate(30 40)");
    updatePreviewTransform(entry, "scale(2)", 1, null, instrumentation);
    expect(node.attributes.get("transform")).toBe("scale(2) translate(30 40)");
    updatePreviewTransform(entry, null, 2, null, instrumentation);
    expect(node.attributes.get("transform")).toBe("translate(30 40)");
    const next = {
      ...element,
      offset: { x: 60, y: 80 },
      pivot: { x: element.pivot.x + 30, y: element.pivot.y + 40 },
    };
    updateMountedGeometry(
      entry,
      createSceneRecord(next),
      parts,
      doc,
      new FakeNode(doc as unknown as FakeDocument, "g") as unknown as SVGGElement,
      instrumentation,
    );
    expect(node.attributes.get("transform")).toBe("translate(60 80)");
    expect(entry.paths[0]!.node.getAttribute("d")).toBe(parts[0]!.d);
  },
);
