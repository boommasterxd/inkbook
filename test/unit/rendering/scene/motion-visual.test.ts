import { describe, expect, it, vi } from "vitest";

import * as elementPath from "../../../../src/domain/geometry/element-path";
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
import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
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

describe("canonical stroke motion reuse", () => {
  it.each([false, true])(
    "reuses canonical local paths with positioned fade geometry (pressure: %s)",
    (pressureEnabled) => {
      const stroke = pressureStroke();
      Object.freeze(stroke.points);
      const local = { ...stroke, style: { ...stroke.style, pressureEnabled } };
      const cache = new ScenePathCache();
      const parts = cache.build(local);
      const moved = {
        ...local,
        offset: { x: 70, y: 40 },
        pivot: { x: local.pivot.x + 70, y: local.pivot.y + 40 },
      };
      const build = vi.spyOn(elementPath, "buildElementPathParts");
      const { document, parent } = motionParent();
      try {
        const visual = createMotionVisual(document, parent, [moved], 32, 100_000, (element) =>
          cache.read(element),
        );
        expect(build).not.toHaveBeenCalled();
        expect(fakeNode(visual.nodes[0]!).attributes.get("d")).toBe(parts[0]!.d);
        expect(fakeNode(visual.nodes[0]!).attributes.get("transform")).toBe("translate(70 40)");
        writeMotionVisual(visual, 0.5, 0.98);
        expect(fakeNode(visual.targets[0]!.node).style["transform"]).toBe(
          pressureEnabled ? "scale(0.98)" : "translate(70px, 40px) scale(0.98)",
        );
        removeMotionVisual(visual);
        expect(fakeNode(parent).nodes).toHaveLength(0);
      } finally {
        build.mockRestore();
        cache.release();
      }
    },
  );
});

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

  it("does not read stroke samples after path or byte capacity is exhausted", () => {
    const stroke = pressureStroke();
    const build = vi.spyOn(elementPath, "buildElementPathParts");
    let pointReads = 0;
    stroke.points = new Proxy(stroke.points, {
      get(points, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) pointReads += 1;
        return Reflect.get(points, key, receiver) as unknown;
      },
    });
    const { document, parent } = motionParent();
    for (const [paths, bytes] of [
      [0, 100_000],
      [32, 0],
    ]) {
      const visual = createMotionVisual(document, parent, [stroke], paths!, bytes!);
      expect(visual).toMatchObject({ bytes: 0, nodes: [], targets: [] });
      expect(pointReads).toBe(0);
      expect(build).not.toHaveBeenCalled();
      expect(fakeNode(parent).nodes).toHaveLength(0);
    }

    const first = pressureStroke();
    const exactBytes = buildElementPathParts(first).reduce(
      (sum, part) => sum + part.d.length * 2,
      0,
    );
    build.mockClear();
    const visual = createMotionVisual(document, parent, [first, stroke], 2, exactBytes);
    expect(visual.nodes).toHaveLength(1);
    expect(visual.bytes).toBe(exactBytes);
    expect(pointReads).toBe(0);
    expect(build).toHaveBeenCalledOnce();
    removeMotionVisual(visual);
    expect(fakeNode(parent).nodes).toHaveLength(0);
    build.mockRestore();
  });
});
