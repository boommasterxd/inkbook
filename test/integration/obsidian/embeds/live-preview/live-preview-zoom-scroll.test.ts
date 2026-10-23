// @vitest-environment happy-dom

import { expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { createInputState } from "../../../../../src/editor/input/index";
import { ActiveEditorNavigation } from "../../../../../src/obsidian/embeds/active-editor/navigation/navigation";
import type { ActiveEditorLayout } from "../../../../../src/obsidian/embeds/active-editor/layout/layout";
import { applyActiveSceneZoomLayout } from "../../../../../src/obsidian/embeds/active-scene/active-scene-runtime";
import { readNavigationLayout } from "../../../../../src/obsidian/embeds/active-editor/navigation/navigation-layout";
import { LivePreviewZoomScrollBinding } from "../../../../../src/obsidian/embeds/live-preview/live-preview-zoom-scroll";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";
import {
  cancelZoomScrollForReason,
  createLivePreviewZoomScrollFixture,
  ZOOM_SCROLL_CANCELLATION_REASONS,
} from "../../../../fixtures/obsidian/live-preview-zoom-scroll";

it("invalidates projected geometry before a host measurement or relayout can restore scrolling", () => {
  const h = createLivePreviewZoomScrollFixture();
  try {
    const initial = h.binding.geometryRevision;
    h.notify();
    expect(h.binding.geometryRevision).toBe(initial);
    h.binding.retain(h.owner, 812);
    h.measure();
    expect(h.binding.geometryRevision).toBe(initial + 1);
    const revisions: number[] = [];
    h.scrollWrite.mockImplementation(() => {
      revisions.push(h.binding.geometryRevision);
      return 812;
    });
    h.notify(false, true);
    expect(revisions).toEqual([initial + 2]);
    h.notify(false, false, true);
    expect(h.binding.geometryRevision).toBe(initial + 3);
    h.notify(true);
    expect(h.binding.geometryRevision).toBe(initial + 4);
    h.binding.retain(h.owner, 900);
    h.binding.cancel();
    h.measure();
    expect(h.binding.geometryRevision).toBe(initial + 4);
  } finally {
    h.destroy();
  }
});

it("owns at most one widget target per host view", () => {
  const h = createLivePreviewZoomScrollFixture();
  const other = new LivePreviewZoomScrollBinding(
    h.view,
    h.root,
    workSchedulerFromFrames(h.frames.window),
  );
  try {
    h.binding.retain(h.owner, 812);
    other.retain(h.owner, 900);
    h.measure();
    expect(h.frames.pending).toBe(1);
    h.owner.scrollTop = 1917;
    h.notify();
    expect(h.owner.scrollTop).toBe(900);
    expect(h.frames.pending).toBe(0);
    other.dispose();
    h.view.setState(EditorState.create({ doc: "ordinary prose" }));
    h.request.mockClear();
    h.binding.retain(h.owner, 800);
    expect(h.request).not.toHaveBeenCalled();
  } finally {
    other.dispose();
    h.destroy();
  }
});

it("restores the latest input anchor after the host height measurement", () => {
  const h = createLivePreviewZoomScrollFixture();
  try {
    h.binding.retain(h.owner, 812.36977);
    h.owner.scrollTop = 812.36977;
    h.notify();
    expect(h.owner.scrollTop).toBe(812.36977);
    h.measure();
    h.owner.scrollTop = 1917;
    h.scrollRead.mockClear();
    h.notify();
    expect(h.scrollRead).toHaveBeenCalledOnce();
    expect(h.owner.scrollTop).toBe(812.36977);
    expect(h.frames.pending).toBe(0);
    h.owner.scrollTop = 900;
    h.notify();
    expect(h.owner.scrollTop).toBe(900);
  } finally {
    h.destroy();
  }
});

it.each([
  [-23.0625, 0],
  [-54.125, 0],
  [12.5, 0],
  [0, 20],
  [-23.0625, 20],
] as const)(
  "retains the content anchor with origin delta %s px and border/padding inset %s px",
  (originDelta, inset) => {
    const h = createLivePreviewZoomScrollFixture();
    let contentTop = 300;
    h.root.style.borderTopWidth = `${String(inset / 2)}px`;
    h.root.style.paddingTop = `${String(inset / 2)}px`;
    const read = vi
      .spyOn(h.root, "getBoundingClientRect")
      .mockImplementation(() => new DOMRect(0, contentTop - h.owner.scrollTop, 800, 2_000));
    try {
      const layout = readNavigationLayout(h.root, h.owner)!;
      expect(layout.containerBounds.top - layout.containerBorderTop!).toBe(inset);
      read.mockClear();
      applyActiveSceneZoomLayout(
        { applyZoom: () => 2_000 } as unknown as ActiveEditorLayout,
        { blockSize: 2_000, layout, scrollTop: 3966, zoom: 5 },
        h.binding,
        h.root,
      );
      expect(read).not.toHaveBeenCalled();
      h.measure();
      contentTop += originDelta;
      h.owner.scrollTop = 1917;
      h.notify();
      expect(h.owner.scrollTop).toBe(3966 + originDelta);
      expect(read).toHaveBeenCalledOnce();
      expect(h.frames.pending).toBe(0);
      h.notify();
      expect(read).toHaveBeenCalledOnce();
    } finally {
      read.mockRestore();
      h.destroy();
    }
  },
);

it.each([NaN, Infinity])("ignores unusable settled host geometry %s", (top) => {
  const h = createLivePreviewZoomScrollFixture();
  const read = vi
    .spyOn(h.root, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, top, 800, 100));
  try {
    h.binding.retain(h.owner, 812, { container: h.root, contentTop: 300 });
    h.measure();
    h.owner.scrollTop = 900;
    h.notify();
    expect(h.owner.scrollTop).toBe(900);
    expect(h.frames.pending).toBe(0);
  } finally {
    read.mockRestore();
    h.destroy();
  }
});

it.each([
  [-60, 23.0625, 5_000, 0],
  [-20, 54.125, 5_000, 34.125],
  [5_500, -100, 4_000, 4_000],
  [4_050, -100, 4_000, 3_950],
] as const)(
  "clamps raw target %s only after origin delta %s at native maximum %s",
  (target, originDelta, nativeMaximum, expected) => {
    const h = createLivePreviewZoomScrollFixture({ nativeMaximum });
    const read = vi
      .spyOn(h.root, "getBoundingClientRect")
      .mockImplementation(() => new DOMRect(0, 300 + originDelta - h.owner.scrollTop, 800, 2_000));
    try {
      h.binding.retain(h.owner, target, { container: h.root, contentTop: 300 });
      h.owner.scrollTop = target;
      expect(h.owner.scrollTop).toBe(Math.max(0, Math.min(nativeMaximum, target)));
      h.measure();
      h.owner.scrollTop = 1_000;
      h.notify();
      expect(h.owner.scrollTop).toBe(expected);
      expect(read).toHaveBeenCalledOnce();
      expect(h.frames.pending).toBe(0);
    } finally {
      read.mockRestore();
      h.destroy();
    }
  },
);

it.each(ZOOM_SCROLL_CANCELLATION_REASONS)("gives up the old zoom anchor on %s", (reason) => {
  const h = createLivePreviewZoomScrollFixture();
  try {
    h.binding.retain(h.owner, 812);
    h.measure();
    cancelZoomScrollForReason(h, reason);
    expectNativeControl(h);
  } finally {
    h.destroy();
  }
});

it("expires a request whose host measure has no changed geometry", () => {
  const h = createLivePreviewZoomScrollFixture();
  try {
    h.binding.retain(h.owner, 812);
    h.measure();
    expect(h.frames.pending).toBe(1);
    h.frames.flushOne();
    expectNativeControl(h);
  } finally {
    h.destroy();
  }
});

it("replaces an already measured epoch before its expiry and ignores canceled work", () => {
  const h = createLivePreviewZoomScrollFixture();
  try {
    h.binding.retain(h.owner, 812);
    h.measure();
    h.binding.retain(h.owner, 900);
    expect(h.frames.pending).toBe(0);
    h.advance(150);
    h.frames.flushOne();
    h.measure();
    h.owner.scrollTop = 900.25;
    h.scrollWrite.mockClear();
    h.notify();
    expect(h.scrollWrite).not.toHaveBeenCalled();
    h.binding.retain(h.owner, 600);
    h.binding.cancel();
    h.measure();
    h.notify();
    expect(h.frames.pending).toBe(0);
    expect(h.scrollWrite).not.toHaveBeenCalled();
  } finally {
    h.destroy();
  }
});

it("rejects another scroll owner and unusable targets", () => {
  const h = createLivePreviewZoomScrollFixture();
  try {
    h.binding.retain(h.root, 812);
    h.binding.retain(h.owner, NaN);
    expect(h.request).not.toHaveBeenCalled();
    h.binding.dispose();
    h.binding.retain(h.owner, 812);
    expect(h.request).not.toHaveBeenCalled();
  } finally {
    h.destroy();
  }
});

function expectNativeControl(h: ReturnType<typeof createLivePreviewZoomScrollFixture>): void {
  h.owner.scrollTop = 900;
  h.notify();
  expect(h.owner.scrollTop).toBe(900);
  expect(h.frames.pending).toBe(0);
}

it.each(["revert", "restore", "revert at original scale"])(
  "preserves the explicit %s scroll target after the host reconciles height shrink",
  (action) => {
    const h = createLivePreviewZoomScrollFixture();
    const navigation = createHostNavigation(h);
    try {
      h.owner.scrollTop = 200;
      navigation.beginPinchScreen({ x: 500, y: 200 });
      navigation.updatePinchScreen({ x: 500, y: 200 }, 2);
      h.frames.flushOne();
      h.measure();
      h.notify();
      expect(navigation.zoom).toBe(2);
      if (action === "revert at original scale") {
        navigation.updatePinchScreen({ x: 500, y: 250 }, 1);
        h.frames.flushOne();
        expect(navigation.zoom).toBe(1);
        expect(h.owner.scrollTop).not.toBe(200);
      }
      if (action.startsWith("revert")) navigation.revert();
      else expect(navigation.restoreViewState({ cameraX: 0, zoom: 1 })).toBe(true);
      const expected = h.owner.scrollTop;
      if (action.startsWith("revert")) expect(expected).toBe(200);
      expect(navigation.zoom).toBe(1);
      h.advance(150);
      h.frames.flushOne();
      h.measure();
      h.owner.scrollTop = 0;
      h.notify();
      expect(h.owner.scrollTop).toBe(expected);
      expect(h.frames.pending).toBe(0);
    } finally {
      navigation.dispose();
      h.destroy();
      vi.restoreAllMocks();
    }
  },
);

function createHostNavigation(h: ReturnType<typeof createLivePreviewZoomScrollFixture>) {
  let height = 2_000;
  let input = createInputState({ fitZoom: 0.4, zoom: 1 });
  Object.defineProperties(h.owner, {
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, get: () => height + 2_000 },
  });
  vi.spyOn(h.owner, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1_000, 500));
  vi.spyOn(h.root, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 300 - h.owner.scrollTop, 1_000, height),
  );
  const layout = {
    applyZoom: (update: { blockSize: number }) => (height = update.blockSize),
  } as unknown as ActiveEditorLayout;
  return new ActiveEditorNavigation({
    activePageHeight: () => 2_000,
    applyCamera: () => undefined,
    applyZoomLayout: (update) => applyActiveSceneZoomLayout(layout, update, h.binding, h.root),
    container: h.root,
    getInput: () => input,
    renderer: {} as never,
    scrollOwner: h.owner,
    setInput: (next) => {
      input = next;
    },
    workScheduler: workSchedulerFromFrames(h.frames.window),
  });
}
