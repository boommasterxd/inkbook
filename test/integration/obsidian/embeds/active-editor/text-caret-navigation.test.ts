// @vitest-environment happy-dom

import { expect, it, vi } from "vitest";
import { prepareTextCaretReveal } from "../../../../../src/obsidian/embeds/active-editor/text-session-presentation";
import { TextEditingViewport } from "../../../../../src/rendering/scene/text-editing-viewport";
import { OUTER_PAGE_WIDTH } from "../../../../../src/editor/zoom/zoom";
import type { TextEditingSurface } from "../../../../../src/rendering/scene/text-editing-surface";
import { createNavigationHarness } from "../../../../fixtures/obsidian/navigation";
import { textElement } from "../../../../fixtures/rendering/text";

it("projects the owned scene caret through a queued navigation frame into the host scroll owner", () => {
  const height = 100_000;
  const width = 1000;
  const zoom = width / OUTER_PAGE_WIDTH;
  const { navigation, frames, owner, containerRect } = createNavigationHarness({
    activePageHeight: height,
    ownerScrollTop: 0,
    ownerScrollHeight: 60_000,
    containerRect: { top: 100, left: 0, width, height: height * zoom },
  });
  const camera = { x: 0, zoom: navigation.zoom };
  const element = textElement({ x: 0, y: 0, height, pivot: { x: 100, y: height / 2 } });
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const viewport = new TextEditingViewport({
    text: { element, group },
    bounds: element,
    clip: document.createElement("div"),
    container: document.createElement("div"),
    context: {
      cameraGroup: group,
      camera,
      viewport: { left: 0, top: 0, width, height: 500 },
      invalidate: vi.fn(),
    },
    onChanged: undefined,
  });
  const surface = {
    pageBoundsForClientRect: (rect) => viewport.pageBounds(rect),
  } as TextEditingSurface;
  const reveal = (bounds: Parameters<typeof navigation.revealBounds>[0]) =>
    navigation.revealBounds(bounds);
  expect(
    prepareTextCaretReveal(
      surface,
      { left: 20, right: 21, top: 48_000, bottom: 48_012 },
      reveal,
    )?.(),
  ).toBe(true);
  expect(owner.scrollTop).toBe(0);
  expect(frames.pending).toBe(1);
  frames.flushAll();
  expect(owner.scrollTop).toBeGreaterThan(47_000);
  containerRect.top = 100 - owner.scrollTop;
  viewport.update({ left: 0, top: -containerRect.top, width, height: 500 }, camera);
  expect(
    prepareTextCaretReveal(surface, { left: 20, right: 21, top: 0, bottom: 12 }, reveal)?.(),
  ).toBe(true);
  frames.flushAll();
  expect(owner.scrollTop).toBeLessThanOrEqual(100);
  navigation.dispose();
  viewport.release();
});
