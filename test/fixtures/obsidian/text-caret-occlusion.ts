import { vi } from "vitest";
import { TextSessionExtent } from "../../../src/obsidian/embeds/active-editor/text-session-extent";
import type { TextEditingSurface } from "../../../src/rendering/scene/text-editing-surface";
import { layoutHarness } from "../../integration/obsidian/embeds/active-editor/layout/active-editor-layout-fixture";
import { createNavigationHarness } from "./navigation";
import { immediateWorkScheduler } from "./immediate-work-scheduler";

/** Real page-height lease and navigation, with a host whose scroll range follows its layout writes. */
export function textCaretOcclusion() {
  const layout = layoutHarness("full");
  layout.rect.width = 360;
  layout.setMaximumBottom(522.344);
  layout.layout.chromeMounted();
  layout.work.flushFrames();
  const original = layout.rect.height;
  const ownerRect = { left: 0, top: 0, width: 360, height: 800 };
  const containerRect = {
    top: 340,
    left: 0,
    width: 360,
    get height() {
      return layout.rect.height;
    },
    set height(value: number) {
      layout.rect.height = value;
    },
  };
  const host = createNavigationHarness({
    activePageHeight: () => layout.layout.currentPageHeight()!,
    containerRect,
    ownerRect,
    ownerScrollTop: 0,
    ownerScrollHeight: 800,
  });
  Object.defineProperties(host.owner, {
    scrollHeight: { get: () => 800 + layout.rect.height - original },
    clientHeight: { get: () => ownerRect.height },
  });
  let sourceHeight = 422.344;
  const extent = new TextSessionExtent({
    scheduler: immediateWorkScheduler(),
    canonicalHeight: () => 422.344,
    input: () => ({ contentHeight: sourceHeight, view: { scaleY: 1 } }),
    surface: {
      setContentHeight: (height: number) => ({
        minX: 120,
        maxX: 520,
        minY: 100,
        maxY: 100 + Math.max(height, 422.344),
      }),
    } as TextEditingSurface,
    layout: {
      begin: () => layout.layout.beginSelectionMove(),
      finish: (committed, bottom, immediate) =>
        layout.layout.finishSelectionMove(committed, bottom, immediate),
      updateBottom: (bottom, immediate) =>
        layout.layout.updateSelectionMoveBottom(bottom, immediate),
    },
  });
  const reserve = vi.fn((bottom: number) => extent.reserveBottom(bottom));
  const caret = { minX: 150, maxX: 151, minY: 100, maxY: 116 };
  const reveal = (top = 320) => host.navigation.revealBounds(caret, top, reserve);
  const flush = () => {
    host.frames.flushAll();
    containerRect.top = 340 - host.owner.scrollTop;
  };
  return {
    layout,
    host,
    original,
    extent,
    reserve,
    reveal,
    flush,
    ownerRect,
    caretBottom: () => containerRect.top + caret.maxY * host.navigation.zoom,
    sourceHeight: (height: number) => {
      sourceHeight = height;
      extent.update();
    },
    dispose: () => {
      extent.dispose();
      host.navigation.dispose();
      layout.layout.dispose();
    },
  };
}
