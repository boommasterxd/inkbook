import { describe, expect, it } from "vitest";

import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import type { StrokeElementV1 } from "../../../../src/domain/schema/public";
import {
  createInstrumentation,
  resetInstrumentation,
} from "../../../../src/rendering/scene/instrumentation";
import {
  appendElementToFragment,
  createMountedElement,
  firstPath,
  removeMountedElement,
  updateMountedElementPreview,
  updateMountedGeometry,
  updatePreviewTransform,
} from "../../../../src/rendering/scene/mounted-element";
import type { SceneElementRecord } from "../../../../src/rendering/scene/types";

import { FakeDocument, FakeNode, fakeNode } from "./fakes";

describe("mounted pressure preview groups", () => {
  it("shares transform and opacity while preserving child pressure widths", () => {
    const fixture = mountedStroke();
    updatePreviewTransform(fixture.entry, "scale(2 0.5)", 1, 0.5, fixture.instrumentation);

    showPressurePreview(fixture);

    const group = fixture.parent.nodes[0]!;
    expect(group.tagName).toBe("g");
    expect(fakeNode(firstPath(fixture.entry))).toBe(group);
    expect(group.attributes.get("opacity")).toBe("0.4");
    expect(group.attributes.get("transform")).toBe("scale(2 0.5)");
    expect(group.nodes.map((path) => path.attributes.get("stroke-opacity"))).toEqual(["1", "1"]);
    expect(group.nodes.map((path) => path.attributes.get("stroke-width"))).toEqual(["0.5", "1"]);
    expect(group.nodes.every((path) => !path.attributes.has("transform"))).toBe(true);
    expect(group.nodes.map((path) => path.attributes.get("vector-effect"))).toEqual([
      "non-scaling-stroke",
      "non-scaling-stroke",
    ]);

    resetInstrumentation(fixture.instrumentation);
    updatePreviewTransform(fixture.entry, "scale(3 0.25)", 2, 0.5, fixture.instrumentation);
    expect(fixture.instrumentation.contentAttributeWrites).toBe(1);
    expect(fixture.instrumentation.contentGeometryWrites).toBe(1);
    expect(group.attributes.get("transform")).toBe("scale(3 0.25)");
    expect(group.nodes.map((path) => path.attributes.get("stroke-width"))).toEqual(["0.5", "1"]);
  });

  it("unwraps to canonical paths and removes the complete preview root", () => {
    const fixture = mountedStroke();
    showPressurePreview(fixture);
    updatePreviewTransform(fixture.entry, "scale(2)", 1, 1, fixture.instrumentation);
    const previewGroup = fixture.parent.nodes[0]!;

    updateMountedGeometry(
      fixture.entry,
      fixture.record,
      buildElementPathParts(fixture.record.element),
      fixture.document as unknown as Document,
      fixture.parent as unknown as SVGGElement,
      fixture.instrumentation,
    );

    expect(previewGroup.parent).toBeUndefined();
    expect(fixture.parent.nodes).toHaveLength(1);
    const canonical = fixture.parent.nodes[0]!;
    expect(canonical.tagName).toBe("path");
    expect(canonical.attributes.get("fill-opacity")).toBe("0.4");
    expect(canonical.attributes.get("stroke-opacity")).toBeUndefined();
    expect(canonical.attributes.get("transform")).toBe("scale(2)");
    expect(fakeNode(firstPath(fixture.entry))).toBe(canonical);

    removeMountedElement(fixture.entry);
    expect(fixture.parent.nodes).toHaveLength(0);
  });
});

describe("pressure group paint and lifecycle", () => {
  it("composites color alpha once instead of darkening overlapping band caps", () => {
    const fixture = mountedStroke({ type: "rgba", value: "#11223380" });
    showPressurePreview(fixture);
    const group = fixture.parent.nodes[0]!;
    expect(Number(group.attributes.get("opacity"))).toBeCloseTo((0.4 * 128) / 255, 10);
    for (const child of group.nodes) {
      expect(child.attributes.get("stroke")).toBe("#112233FF");
      expect(child.attributes.get("stroke-opacity")).toBe("1");
    }
  });

  it("moves and removes the group as a single ordered element", () => {
    const fixture = mountedStroke();
    showPressurePreview(fixture);
    const group = fixture.parent.nodes[0]!;
    const fragment = new FakeNode(fixture.document, "#fragment", true);
    appendElementToFragment(fixture.entry, fragment as unknown as DocumentFragment);
    expect(fragment.nodes).toEqual([group]);
    expect(group.nodes).toHaveLength(2);
    fixture.parent.append(fragment);
    expect(fixture.parent.nodes).toEqual([group]);
    removeMountedElement(fixture.entry);
    expect(fixture.parent.nodes).toHaveLength(0);
    expect(group.parent).toBeUndefined();
  });
});

function showPressurePreview(fixture: ReturnType<typeof mountedStroke>): void {
  updateMountedElementPreview(
    fixture.entry,
    fixture.record,
    fixture.record.element,
    previewParts(),
    {
      instrumentation: fixture.instrumentation,
      ownerDocument: fixture.document as unknown as Document,
      parent: fixture.parent as unknown as SVGGElement,
      pressurePreview: true,
    },
  );
}

function mountedStroke(
  color: StrokeElementV1["style"]["color"] = { type: "rgba", value: "#112233FF" },
) {
  const document = new FakeDocument();
  const parent = new FakeNode(document, "g");
  const record = strokeRecord(color);
  const instrumentation = createInstrumentation();
  const entry = createMountedElement(
    document as unknown as Document,
    record,
    buildElementPathParts(record.element),
    instrumentation,
  );
  const fragment = new FakeNode(document, "#fragment", true);
  appendElementToFragment(entry, fragment as unknown as DocumentFragment);
  parent.append(fragment);
  return { document, entry, instrumentation, parent, record };
}

function previewParts() {
  return [
    { d: "M0 0L10 0", paint: "stroke" as const, strokeWidth: 1 },
    { d: "M10 0L20 0", paint: "stroke" as const, strokeWidth: 2 },
  ];
}

function strokeRecord(
  color: StrokeElementV1["style"]["color"],
): SceneElementRecord & { readonly element: StrokeElementV1 } {
  const element: StrokeElementV1 = {
    createdAt: 0,
    id: "pressure-stroke",
    kind: "stroke",
    pivot: { x: 10, y: 0 },
    points: [0, 0, 0, 10, 0, 0.5, 20, 0, 1],
    rotation: 0,
    style: {
      color,
      opacity: 0.4,
      pressureEnabled: true,
      smoothing: 0.5,
      width: 2,
    },
    tool: "pen",
  };
  return {
    band: "content",
    bounds: { maxX: 21, maxY: 1, minX: -1, minY: -1 },
    element,
    geometryVersion: 1,
    id: element.id,
    paintVersion: 1,
    rank: 0,
  };
}
