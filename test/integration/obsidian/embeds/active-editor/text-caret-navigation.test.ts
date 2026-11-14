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

function animatedNavigation(motion: "full" | "reduced" = "full") {
  const state = createNavigationHarness({ motion, ownerScrollTop: 0 });
  let scrollTop = 0;
  Object.defineProperty(state.owner, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
      state.containerRect.top = 100 - value;
    },
  });
  const reveal = (bottom = 1000) =>
    state.navigation.revealBounds(
      { minX: 20, maxX: 21, minY: bottom - 20, maxY: bottom },
      undefined,
      undefined,
      true,
    );
  return { ...state, reveal };
}

it("animates native caret scrolling and retargets repeated input continuously within one settle", () => {
  const state = animatedNavigation();
  state.reveal();
  state.frames.flushOne();
  state.frames.flushOne();
  const initial = state.owner.scrollTop;
  expect(initial).toBeGreaterThan(0);
  expect(100 + 1000 * state.navigation.zoom - initial).toBeGreaterThan(484);
  state.frames.flushOne();
  const beforeRetarget = state.owner.scrollTop;
  state.reveal(1100);
  expect(state.owner.scrollTop).toBe(beforeRetarget);
  expect(state.frames.pending).toBe(1);
  state.frames.flushOne();
  expect(state.owner.scrollTop).toBeGreaterThan(beforeRetarget);
  for (let frame = 0; frame < 9 && state.frames.pending; frame++) state.frames.flushOne();
  expect(state.frames.pending).toBe(0);
  expect(state.containerRect.top + 1100 * state.navigation.zoom).toBeCloseTo(484);
  state.navigation.dispose();
});

it("settles reduced-motion reveal in one frame and cancels animated reveal for direct navigation", () => {
  const reduced = animatedNavigation("reduced");
  reduced.reveal();
  reduced.frames.flushOne();
  expect(reduced.frames.pending).toBe(0);
  expect(reduced.containerRect.top + 1000 * reduced.navigation.zoom).toBeCloseTo(484);
  reduced.navigation.dispose();
  const state = animatedNavigation();
  state.reveal();
  state.frames.flushOne();
  state.frames.flushOne();
  const stopped = state.owner.scrollTop;
  expect(
    state.navigation.updateWheel({ clientX: 0, clientY: 0, deltaMode: 0, deltaX: 0, deltaY: 40 }),
  ).toBe(false);
  expect(state.frames.pending).toBe(0);
  expect(state.owner.scrollTop).toBe(stopped);
  state.reveal();
  state.navigation.cancelPanMomentum();
  expect(state.frames.pending).toBe(0);
  state.reveal();
  state.navigation.dispose();
  expect(state.frames.pending).toBe(0);
});
