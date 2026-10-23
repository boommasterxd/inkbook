// @vitest-environment happy-dom

import { expect, it, vi } from "vitest";

import { layoutHarness } from "../../../../integration/obsidian/embeds/active-editor/layout/active-editor-layout-fixture";
import { ownZoomResizeFixture } from "../../../../fixtures/obsidian/own-zoom-resize";
import { ownZoomScrollFixture } from "../../../../fixtures/obsidian/own-zoom-scroll";

import { PresentationController } from "../../../../../src/obsidian/embeds/presentation/presentation-controller";
import { ColorSchemeBroadcaster } from "../../../../../src/obsidian/theme/color-scheme";
import { FakePresentationElement } from "../../../../fixtures/obsidian/presentation-dom";
import { createPresentationMotionWindow } from "../../../../fixtures/obsidian/presentation-motion-window";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";

const LAYOUT_SAMPLES = 600;

it("bounds root measurement across resize bursts and retained editor visibility changes", () => {
  const h = measurementHarness();
  h.controller.mount();
  h.flushFrames();

  for (const state of ["active", "locked", "active"] as const) {
    h.root.dataset.inkbookState = state;
    h.background.hidden = state === "locked";
    h.rootRead.mockClear();
    h.ownerRead.mockClear();
    h.styleRead.mockClear();
    for (let event = 0; event < 1_000; event += 1) h.resize();

    expect(h.rootRead).not.toHaveBeenCalled();
    expect(h.ownerRead).not.toHaveBeenCalled();
    expect(h.frames.size).toBe(2);
    h.flushFrames();
    expect(h.rootRead).toHaveBeenCalledOnce();
    expect(h.ownerRead).toHaveBeenCalledOnce();
    expect(
      h.styleRead.mock.calls.filter(([element]) => element === (h.root as unknown as HTMLElement)),
    ).toHaveLength(1);
    expect(h.styleRead.mock.calls.length).toBeLessThanOrEqual(2);
    expect(h.shellRadius()).toBe("14px");
    expect(h.frames.size).toBe(0);
  }

  expect(h.backgroundRead).not.toHaveBeenCalled();
  expect(h.backgroundQuery).not.toHaveBeenCalled();
  h.resize();
  expect(h.frames.size).toBe(2);
  h.controller.dispose();
  expect(h.frames.size).toBe(0);
  h.rootRead.mockClear();
  h.resize();
  h.flushFrames();
  expect(h.rootRead).not.toHaveBeenCalled();
  expect(h.frames.size).toBe(0);
});

function measurementHarness() {
  const owner = new FakePresentationElement();
  owner.clientWidth = 1_000;
  const root = new FakePresentationElement(owner.ownerDocument);
  owner.append(root);
  const background = root.createDiv({ cls: "inkbook-background-container" });
  const ownerWindow = root.ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("Missing owner window.");
  const motion = createPresentationMotionWindow();
  const { frames } = motion;
  Object.assign(ownerWindow, {
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      motion.ownerWindow.requestAnimationFrame(callback),
    cancelAnimationFrame: (id: number) => motion.ownerWindow.cancelAnimationFrame(id),
  });
  const rootRead = vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
    bottom: 100,
    height: 100,
    left: 0,
    right: 700,
    top: 0,
    width: 700,
  });
  const styles = new Map<string, string>();
  root.style.setProperty = (name, value) => styles.set(name, value);
  const controller = createController(root, ownerWindow);
  return {
    background,
    controller,
    frames,
    root,
    rootRead,
    backgroundQuery: vi.spyOn(root, "getElementsByClassName"),
    backgroundRead: vi.spyOn(background, "getBoundingClientRect"),
    ownerRead: vi.spyOn(owner, "getBoundingClientRect"),
    styleRead: vi.spyOn(ownerWindow, "getComputedStyle"),
    shellRadius: () => styles.get("--inkbook-shell-radius"),
    resize: () => ownerWindow.dispatchEvent(new Event("resize")),
    flushFrames: () => {
      for (let frame = 0; frames.size > 0 && frame < 3; frame += 1) {
        motion.frame(0);
      }
      expect(frames.size).toBe(0);
    },
  };
}

function createController(root: FakePresentationElement, ownerWindow: Window) {
  return new PresentationController(
    {
      attachmentGeneration: 1,
      attachmentId: "measurement-work",
      documentId: "drawings/ink.svg",
      embedReference: {
        documentId: "drawings/ink.svg",
        from: 4,
        kind: "live-preview",
        sourcePath: "notes/note.md",
        to: 28,
      },
      root: root as unknown as HTMLElement,
    },
    { activate: vi.fn(), detach: vi.fn(), mount: vi.fn() },
    new ColorSchemeBroadcaster({ getColorScheme: () => "light" }),
    undefined,
    workSchedulerFromFrames(ownerWindow),
  );
}

it("bounds own-scroll proof reads without repeating complete scene measurements", () => {
  const h = ownZoomScrollFixture();
  try {
    for (let index = 0; index < LAYOUT_SAMPLES; index += 1) {
      h.zoom(index % 2 === 0 ? 200 : 400, index % 2 === 0 ? 200 : 100);
      h.scroll();
    }
    const count = LAYOUT_SAMPLES;
    expect(h.fullRead).not.toHaveBeenCalled();
    expect(h.style).toHaveBeenCalledTimes(count);
    expect(h.box).toHaveBeenCalledTimes(count * 2);
    expect(h.ownerBox).toHaveBeenCalledTimes(count * 2);
    expect(h.onScroll).toHaveBeenCalledTimes(count);
    h.h.renderer.invalidateLayout();
    h.scroll();
    expect(h.fullRead).toHaveBeenCalledOnce();
    expect(h.style).toHaveBeenCalledTimes(count + 1);
    h.binding.dispose();
    h.scroll();
    expect(h.fullRead).toHaveBeenCalledOnce();
  } finally {
    h.dispose();
  }
});

it("validates each own projected observer report once without invalidating a second scene frame", () => {
  const { h, zoom, notify, reset, read, box, ownerBox } = ownZoomResizeFixture();
  reset();
  for (let index = 0; index < LAYOUT_SAMPLES; index += 1) {
    const height = index % 2 === 0 ? 200 : 100;
    zoom(height);
    notify(height + 40);
  }
  const count = LAYOUT_SAMPLES;
  expect(h.invalidateLayout).toHaveBeenCalledTimes(count);
  expect(read).toHaveBeenCalledTimes(count * 2);
  expect(box).toHaveBeenCalledTimes(count * 2);
  expect(ownerBox).toHaveBeenCalledTimes(count * 2);
  expect(h.work.frames.size).toBe(0);
  h.layout.dispose();
});
it("keeps settled page geometry out of continuous zoom layout work", () => {
  const harness = layoutHarness("reduced");
  harness.layout.chromeMounted();
  harness.work.flushFrames();
  harness.setMaximumBottom(5_000);
  harness.layout.contentChanged();
  harness.work.flushFrames();
  const pageHeight = harness.layout.currentPageHeight()!;
  const pageWrites = harness.setPage.mock.calls.length;
  harness.invalidateLayout.mockClear();

  for (let frame = 0; frame < LAYOUT_SAMPLES; frame += 1) {
    const zoom = frame % 2 === 0 ? 2 : 4;
    harness.layout.applyZoom({ blockSize: pageHeight * zoom, zoom });
  }

  expect(harness.setPage).toHaveBeenCalledTimes(pageWrites);
  expect(harness.invalidateLayout).toHaveBeenCalledTimes(LAYOUT_SAMPLES);
  expect(harness.rendererPageHeight()).toBe(pageHeight);
  expect(harness.rect.height).toBeCloseTo(pageHeight * 4);
  expect(harness.work.frames.size).toBe(0);
  harness.layout.dispose();
  expect(harness.work.frames.size).toBe(0);
});
