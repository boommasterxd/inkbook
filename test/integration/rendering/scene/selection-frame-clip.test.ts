import { describe, expect, it } from "vitest";

import { createSelectionTraceFixture } from "../../../fixtures/rendering/selection-traces";
import { fakeNode } from "../../../unit/rendering/scene/fakes";

function setup() {
  const fixture = createSelectionTraceFixture([]);
  const root = fakeNode(fixture.renderer.svg);
  const overlay = root.nodes[2]!.nodes[1]!;
  const handles = root.nodes[2]!.nodes[2]!;
  const clip = root.nodes[3]!.nodes.find(({ tagName }) => tagName === "clipPath")!;
  return { ...fixture, root, overlay, handles, clip, clipPath: clip.nodes[0]! };
}

describe("inside selection frame", () => {
  it("clips the frame to the unchanged screen polygon without clipping its handles", () => {
    const { renderer, overlay, handles, clip, clipPath } = setup();
    expect(clip.attributes.get("clipPathUnits")).toBe("userSpaceOnUse");
    expect(overlay.attributes.get("clip-path")).toBe(`url(#${clip.attributes.get("id")!})`);
    expect(handles.attributes.has("clip-path")).toBe(false);
    for (const path of [
      "M 0 0 L 100 0 L 100 50 L 0 50 Z",
      "M 50 0 L 100 50 L 50 100 L 0 50 Z",
      "M 0 0 L 0.1 0 L 0.1 0.1 L 0 0.1 Z",
      "M 0 0 L 0 0 L 0 0 L 0 0 Z",
    ]) {
      renderer.setSelectionOverlayPath(path, "accent", "M 0 0 L 5 5");
      renderer.flushPointerFeedbackFrame();
      expect(overlay.attributes.get("d")).toBe(path);
      expect(clipPath.attributes.get("d")).toBe(path);
      expect(overlay.attributes.get("data-selection-fill")).toBe("accent");
      expect(handles.attributes.get("d")).toBe("M 0 0 L 5 5");
    }
    renderer.destroy();
  });

  it("retains clipping during fade-out and clears it on completion or interruption", () => {
    const { renderer, scheduler, overlay, clipPath } = setup();
    const path = "M 0 0 L 100 0 L 100 50 L 0 50 Z";
    renderer.setSelectionOverlayPath(path);
    scheduler.runAll();
    renderer.setSelectionOverlayPath(null);
    renderer.flushPointerFeedbackFrame();
    expect(clipPath.attributes.get("d")).toBe(path);
    scheduler.runAll();
    expect(overlay.attributes.get("d")).toBe("");
    expect(clipPath.attributes.get("d")).toBe("");
    renderer.setSelectionOverlayPath(path);
    scheduler.runAll();
    renderer.setSelectionOverlayPath(null);
    renderer.flushPointerFeedbackFrame();
    renderer.interruptMotionForPointerDown();
    expect(clipPath.attributes.get("d")).toBe("");
    renderer.destroy();
  });

  it("owns independent clipping definitions for simultaneous scenes", () => {
    const first = setup();
    const second = setup();
    expect(first.clip.attributes.get("id")).not.toBe(second.clip.attributes.get("id"));
    first.renderer.destroy();
    expect(first.root.parent).toBeUndefined();
    expect(second.root.parent).toBeDefined();
    second.renderer.destroy();
  });
});
