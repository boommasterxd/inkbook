import { describe, expect, it } from "vitest";

import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import {
  createMountedElement,
  firstPath,
  updatePreviewTransform,
} from "../../../../src/rendering/scene/mounted-element";

import { FakeDocument, fakeNode, fakeRectangleRecord } from "./fakes";

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
