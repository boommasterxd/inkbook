import { describe, expect, it } from "vitest";

import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { normalizeStrokePaint } from "../../../../src/domain/geometry/pressure-paint";
import {
  clearMotionStyle,
  createMotionVisual,
  removeMotionVisual,
  writeMotionVisual,
} from "../../../../src/rendering/scene/motion-visual";
import { SVG_NAMESPACE } from "../../../../src/rendering/scene/constants";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { asDocument, FakeDocument, fakeNode } from "./fakes";

function pressureStroke() {
  const stroke = indexedStroke(1);
  stroke.points = [0, 0, 0, 10, 10, 1, 0, 0, 0];
  stroke.style = { ...stroke.style, color: { type: "rgba", value: "#12345680" }, opacity: 0.4 };
  return stroke;
}

function motionParent() {
  const document = asDocument(new FakeDocument());
  const parent = document.createElementNS(SVG_NAMESPACE, "g");
  return { document, parent };
}

describe("pressure motion visuals", () => {
  it("composites continuous pressure geometry once during a fade", () => {
    const stroke = pressureStroke();
    const { document, parent } = motionParent();
    const visual = createMotionVisual(document, parent, [stroke], 32, 100_000);
    const group = fakeNode(parent).nodes[0]!;
    const opacity = normalizeStrokePaint(stroke.style).opacity;
    expect(group.tagName).toBe("g");
    expect(group.attributes.get("opacity")).toBe(String(opacity));
    expect(visual.nodes).toHaveLength(buildElementPathParts(stroke).length);
    expect(visual.nodes).toHaveLength(1);
    expect(visual.targets).toHaveLength(1);
    for (const node of visual.nodes) {
      expect(fakeNode(node).attributes.get("fill")).toBe("#123456FF");
      expect(fakeNode(node).attributes.get("fill-opacity")).toBe("1");
    }
    writeMotionVisual(visual, 0.5, 0.98);
    expect(Number(group.style["opacity"])).toBeCloseTo(opacity * 0.5, 4);
    expect(group.style["transform"]).toBe("scale(0.98)");
    expect(visual.nodes.every((node) => fakeNode(node).style["opacity"] === undefined)).toBe(true);
    clearMotionStyle(visual.targets[0]!.node);
    expect(group.style["opacity"]).toBeUndefined();
    expect(group.attributes.get("opacity")).toBe(String(opacity));
    removeMotionVisual(visual);
    expect(fakeNode(parent).nodes).toHaveLength(0);
  });

  it("keeps path and byte budgets exact without publishing a partial pressure stroke", () => {
    const stroke = pressureStroke();
    const parts = buildElementPathParts(stroke);
    const bytes = parts.reduce((sum, part) => sum + part.d.length * 2, 0);
    const { document, parent } = motionParent();
    for (const [pathLimit, byteLimit] of [
      [parts.length - 1, bytes],
      [parts.length, bytes - 1],
    ]) {
      const visual = createMotionVisual(document, parent, [stroke], pathLimit!, byteLimit!);
      expect(visual.nodes).toHaveLength(0);
      expect(visual.targets).toHaveLength(0);
      expect(visual.bytes).toBe(0);
      expect(fakeNode(parent).nodes).toHaveLength(0);
    }
    const visual = createMotionVisual(document, parent, [stroke], parts.length, bytes);
    expect(visual.nodes).toHaveLength(parts.length);
    expect(visual.bytes).toBe(bytes);
  });

  it("retains ordinary path fade behavior and bounded rejection", () => {
    const stroke = pressureStroke();
    stroke.style = { ...stroke.style, pressureEnabled: false };
    const { document, parent } = motionParent();
    expect(createMotionVisual(document, parent, [stroke], 0, 100_000).nodes).toHaveLength(0);
    expect(createMotionVisual(document, parent, [stroke], 32, 0).nodes).toHaveLength(0);
    const visual = createMotionVisual(document, parent, [stroke], 1, 100_000);
    expect(visual.targets[0]!.node).toBe(visual.nodes[0]);
    writeMotionVisual(visual, 0.5, 1);
    expect(fakeNode(visual.nodes[0]!).style["opacity"]).toBe("0.5");
    expect(fakeNode(visual.nodes[0]!).attributes.get("stroke-opacity")).toBe("0.4");
    removeMotionVisual(visual);
    expect(fakeNode(parent).nodes).toHaveLength(0);
  });
});
