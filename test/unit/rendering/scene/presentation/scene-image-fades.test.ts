import { describe, expect, it, vi } from "vitest";
import { SceneImageFades } from "../../../../../src/rendering/scene/presentation/scene-image-fades";
import { setElementFadeNode } from "../../../../../src/rendering/scene/presentation/element-fade-style";
import { bindImagePaintInstrumentation } from "../../../../../src/rendering/scene/content/image-opacity";
import { createInstrumentation } from "../../../../../src/rendering/scene/instrumentation";
import { FakeDocument, FakeNode, asDocument } from "../fakes";

function fixture() {
  const document = asDocument(new FakeDocument());
  const node = document.createElementNS("http://www.w3.org/2000/svg", "g");
  node.setAttribute("data-inkbook-image", "");
  const owner = new SceneImageFades();
  let time = 0;
  const now = () => time;
  const instrumentation = createInstrumentation();
  bindImagePaintInstrumentation(node, instrumentation);
  return {
    node,
    owner,
    now,
    instrumentation,
    time: (value: number) => {
      time = value;
    },
  };
}

describe("shared image fade opacity", () => {
  it("retains the 150ms history fade in authored paint without starting an unshared native effect", () => {
    const f = fixture();
    const native = vi.spyOn(FakeNode.prototype, "animate");
    try {
      f.owner.apply(f.node, 150, "opacity", { direction: "enter", generation: 0 }, f.now);
      expect(f.node.style.getPropertyValue("opacity")).toContain("--inkbook-history-active-0");
      f.time(75);
      f.owner.advance(Infinity, f.now);
      const intermediate = f.node.style.getPropertyValue("opacity");
      expect(intermediate).toContain("--inkbook-history-active-0");
      expect(intermediate).toContain(" + 1 * ");
      expect(f.owner.pending).toBe(true);
      f.time(150);
      f.owner.advance(Infinity, f.now);
      expect(f.node.style.getPropertyValue("opacity")).toBe("1");
      expect(f.owner.pending).toBe(false);
      expect(native).not.toHaveBeenCalled();
      expect(f.instrumentation.attributeWrites).toBe(3);
      setElementFadeNode(f.node, null, "opacity");
      expect(f.node.style.getPropertyValue("opacity")).toBe("");
      expect(f.owner.memoryUsage()).toBe(0);
    } finally {
      native.mockRestore();
      f.owner.release();
    }
  });

  it("normalizes repeated interruptions instead of retaining nested calculations or old gates", () => {
    const f = fixture();
    for (let generation = 0; generation < 20; generation += 1) {
      f.owner.apply(
        f.node,
        150,
        "opacity",
        {
          direction: generation % 2 === 0 ? "enter" : "exit",
          generation,
        },
        f.now,
      );
      f.time(generation * 75 + 75);
      f.owner.advance(Infinity, f.now);
      const opacity = f.node.style.getPropertyValue("opacity");
      expect(opacity.length).toBeLessThan(200);
      const gates = [...opacity.matchAll(/--inkbook-history-active-(\d+)/g)].map((match) =>
        Number(match[1]),
      );
      expect(gates.every((gate) => gate === generation)).toBe(true);
      f.owner.interrupt(generation);
    }
    setElementFadeNode(f.node, null, "opacity");
    expect(f.node.style.getPropertyValue("opacity")).toBe("");
    expect(f.owner.pending).toBe(false);
    expect(f.owner.memoryUsage()).toBe(0);
  });

  it("keeps other element fades on the established NativeAnimation path", () => {
    const f = fixture();
    f.node.removeAttribute("data-inkbook-image");
    const native = vi.spyOn(FakeNode.prototype, "animate");
    try {
      f.owner.apply(f.node, 150, "opacity", { direction: "exit" }, f.now);
      expect(native).toHaveBeenCalledOnce();
      expect(f.owner.pending).toBe(false);
      setElementFadeNode(f.node, null, "opacity");
    } finally {
      native.mockRestore();
      f.owner.release();
    }
  });
});
