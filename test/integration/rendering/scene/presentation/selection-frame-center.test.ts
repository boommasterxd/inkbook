import { expect, it } from "vitest";
import { createSelectionTraceFixture } from "../../../../fixtures/rendering/selection-traces";
import { rectangle } from "../../../../unit/domain/schema/fixtures";
import { fakeNode } from "../../../../unit/rendering/scene/fakes";

it("keeps frame geometry centered and leaves handles and degenerate frames unclipped", () => {
  const { renderer } = createSelectionTraceFixture([]);
  const root = fakeNode(renderer.svg);
  const overlay = root.nodes[2]!.nodes[1]!;
  const handles = root.nodes[2]!.nodes[2]!;
  expect(root.nodes[3]!.nodes.some(({ tagName }) => tagName === "clipPath")).toBe(false);
  expect(overlay.attributes.has("clip-path")).toBe(false);
  expect(handles.attributes.has("clip-path")).toBe(false);
  for (const path of ["M0 0L100 0L100 50L0 50Z", "M50 0L100 50L50 100L0 50Z", "M0 0L0 0L0 0Z"]) {
    renderer.setSelectionOverlayPath(path, "accent", "M0 0L5 5");
    renderer.flushPointerFeedbackFrame();
    expect(overlay.attributes.get("d")).toBe(path);
    expect(handles.attributes.get("d")).toBe("M0 0L5 5");
  }
  renderer.destroy();
});

it("avoids duplicate single rectangle borders while retaining fill, handles and the optional frame", () => {
  const source = rectangle();
  const { renderer, select, scheduler } = createSelectionTraceFixture([source]);
  const overlay = fakeNode(renderer.svg).nodes[2]!.nodes[1]!;
  renderer.setSelectionOverlayPath("M0 0L100 0L100 50Z", "accent", "M0 0L5 5");
  select();
  expect(overlay.attributes.get("data-center-outline")).toBe("true");
  expect(overlay.attributes.get("data-selection-fill")).toBe("accent");
  renderer.setSelectionHighlightsEnabled(false);
  scheduler.runAll();
  expect(overlay.attributes.get("data-center-outline")).toBe("false");
  expect(overlay.attributes.get("d")).not.toBe("");
  renderer.setSelectionHighlightsEnabled(true);
  scheduler.runAll();
  expect(overlay.attributes.get("data-center-outline")).toBe("true");
  select([]);
  expect(overlay.attributes.get("data-center-outline")).toBe("false");
  renderer.destroy();
});

it("retains frame geometry during exit and clears it on completion or interruption", () => {
  const { renderer, scheduler } = createSelectionTraceFixture([]);
  const overlay = fakeNode(renderer.svg).nodes[2]!.nodes[1]!;
  const path = "M0 0L100 0L100 50Z";
  renderer.setSelectionOverlayPath(path);
  scheduler.runAll();
  renderer.setSelectionOverlayPath(null);
  renderer.flushPointerFeedbackFrame();
  expect(overlay.attributes.get("d")).toBe(path);
  scheduler.runAll();
  expect(overlay.attributes.get("d")).toBe("");
  renderer.setSelectionOverlayPath(path);
  scheduler.runAll();
  renderer.setSelectionOverlayPath(null);
  renderer.flushPointerFeedbackFrame();
  renderer.interruptMotionForPointerDown();
  expect(overlay.attributes.get("d")).toBe("");
  renderer.destroy();
});
