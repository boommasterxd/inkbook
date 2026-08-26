import { describe, expect, it, vi } from "vitest";

import { derivePageExtent, PAGE_WIDTH } from "../../../../src/domain/geometry/public";
import type { PageV1 } from "../../../../src/domain/schema/public";
import {
  applyLockedFitLayout,
  LOCK_PRESENTATION_DURATION_MS,
  restoreActiveLayout,
  type SceneLayoutUpdate,
} from "../../../../src/obsidian/embeds/active-scene-lock";
import { domRect } from "../../../fixtures/obsidian/active-editor";

const page: PageV1 = {
  activeBufferLines: 3,
  background: { spacing: 100, type: "lines" },
  innerWidth: 2_000,
  lockedBufferLines: 1,
  margin: 24.3,
  writingLineHeight: 100,
};

describe("active scene lock layout", () => {
  it("retains the presentation until the whole-toolbar exit completes", () => {
    expect(LOCK_PRESENTATION_DURATION_MS).toBe(300);
  });

  it("animates content-box fit camera and height on one 240 ms timeline", () => {
    const fixture = createFixture();
    const transition = applyLockedFitLayout(fixture.options(false));
    const expectedFit = 1_000 / PAGE_WIDTH;
    const expectedHeight = derivePageExtent(page, null).lockedHeight * expectedFit;

    fixture.runFrame(120);
    const halfway = fixture.applyResize.mock.calls[fixture.applyResize.mock.calls.length - 1]?.[0];
    expect(Number.parseFloat(fixture.style.blockSize)).toBeGreaterThan(expectedHeight);
    expect(Number.parseFloat(fixture.style.blockSize)).toBeLessThan(480);
    expect(halfway?.zoom).toBeGreaterThan(expectedFit);
    expect(halfway?.zoom).toBeLessThan(1);
    expect(halfway?.cameraX).not.toBe(-100);

    fixture.runFrame(240);
    expect(Number.parseFloat(fixture.style.blockSize)).toBeCloseTo(expectedHeight);
    expect(fixture.applyResize).toHaveBeenLastCalledWith(
      expect.objectContaining({ fitZoom: expectedFit, zoom: expectedFit }),
    );
    expect(fixture.frames.size).toBe(0);
    expect(fixture.onSettled).toHaveBeenCalledOnce();
    transition.finish();
    expect(fixture.applyResize).toHaveBeenCalledTimes(2);
  });

  it("defers reduced-motion camera and height until synchronous finalization", () => {
    const fixture = createFixture();
    const transition = applyLockedFitLayout(fixture.options(true));

    expect(fixture.style.blockSize).toBe("480px");
    expect(fixture.applyResize).not.toHaveBeenCalled();
    expect(fixture.frames.size).toBe(0);

    transition.finish();

    const expectedFit = 1_000 / PAGE_WIDTH;
    expect(Number.parseFloat(fixture.style.blockSize)).toBeCloseTo(
      derivePageExtent(page, null).lockedHeight * expectedFit,
    );
    expect(fixture.applyResize).toHaveBeenCalledWith(
      expect.objectContaining({ fitZoom: expectedFit, zoom: expectedFit }),
    );
  });

  it("cancels pending frames without committing the locked target", () => {
    const fixture = createFixture();
    const transition = applyLockedFitLayout(fixture.options(false));

    transition.cancel();

    expect(fixture.frames.size).toBe(0);
    expect(fixture.style.blockSize).toBe("480px");
    expect(fixture.applyResize).not.toHaveBeenCalled();
    expect(fixture.onSettled).toHaveBeenCalledOnce();
  });

  it("stops animation work after the container is detached", () => {
    const fixture = createFixture();
    applyLockedFitLayout(fixture.options(false));
    fixture.connected.value = false;

    fixture.runFrame(120);

    expect(fixture.applyResize).not.toHaveBeenCalled();
    expect(fixture.frames.size).toBe(0);
  });

  it("restores the active camera without competing with scroll stabilization", () => {
    const fixture = createFixture();
    const blockSizeDuringResize: string[] = [];
    fixture.applyResize.mockImplementation(() => {
      blockSizeDuringResize.push(fixture.style.blockSize);
      return true;
    });

    restoreActiveLayout({
      anchor: fixture.anchor,
      applyResize: fixture.applyResize,
      container: fixture.container,
      currentViewState: { cameraX: 0, zoom: 1_000 / PAGE_WIDTH },
      restoreViewState: vi.fn(() => true),
      targetBlockSize: "600px",
      targetViewState: { cameraX: -80, zoom: 1 },
    });

    expect(fixture.style.blockSize).toBe("600px");
    expect(blockSizeDuringResize).toEqual(["600px"]);
    expect(fixture.applyResize).toHaveBeenCalledWith(
      expect.objectContaining({ fitZoom: 1_000 / PAGE_WIDTH, zoom: 1 }),
    );
    expect(fixture.applyResize.mock.calls[0]?.[0].scrollTop).toBeUndefined();
  });
});

describe("active scene overlapping lock layout", () => {
  it("freezes the visible unlock height before the first lock frame", () => {
    const fixture = createFixture();
    fixture.setInlineBlockSize("720px");
    fixture.setVisibleHeight(612.25);

    applyLockedFitLayout(fixture.options(false));

    expect(fixture.style.blockSize).toBe("612.25px");
    expect(fixture.applyResize).not.toHaveBeenCalled();
  });
});

describe("active scene occupied lock extent", () => {
  it("keeps the last pattern row plus one complete row", () => {
    const fixture = createFixture();
    const maximumBottom = page.margin + 101;
    const transition = applyLockedFitLayout(fixture.options(true, maximumBottom));

    transition.finish();

    const expectedFit = 1_000 / PAGE_WIDTH;
    expect(Number.parseFloat(fixture.style.blockSize)).toBeCloseTo(
      derivePageExtent(page, maximumBottom).lockedHeight * expectedFit,
    );
  });
});

function createFixture() {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const ownerWindow = {
    cancelAnimationFrame: (id: number) => void frames.delete(id),
    getComputedStyle: () => ({
      borderBottomWidth: "2px",
      borderLeftWidth: "2px",
      borderRightWidth: "2px",
      borderTopWidth: "2px",
      paddingBottom: "10px",
      paddingLeft: "10px",
      paddingRight: "10px",
      paddingTop: "10px",
    }),
    performance: { now: () => 0 },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
  } as unknown as Window;
  let inlineBlockSize = "480px";
  const style = {
    get blockSize() {
      return inlineBlockSize;
    },
    set blockSize(value: string) {
      inlineBlockSize = value;
    },
    setProperty: vi.fn(),
  } as unknown as CSSStyleDeclaration;
  let visibleHeight = 480;
  const connected = { value: true };
  const container = {
    getBoundingClientRect: () => domRect({ height: visibleHeight, left: 0, top: 0, width: 1_024 }),
    get isConnected() {
      return connected.value;
    },
    ownerDocument: { defaultView: ownerWindow },
    setCssProps: vi.fn(),
    style,
  } as unknown as HTMLElement;
  const applyResize = vi.fn<(update: SceneLayoutUpdate) => boolean>(() => true);
  const onSettled = vi.fn();
  const anchor = {
    anchorViewportY: 300,
    embedTopInScrollContent: 200,
    oldScrollTop: 400,
    scrollBounds: { min: 0, max: 2_000 },
    viewportWidth: 1_000,
  };
  return {
    anchor,
    applyResize,
    connected,
    container,
    frames,
    options: (reducedMotion: boolean, maximumBottom?: number) => ({
      anchor,
      applyResize,
      container,
      maximumBottom,
      oldViewState: { cameraX: -100, zoom: 1 },
      onSettled,
      page,
      reducedMotion,
      restoreViewState: vi.fn(() => true),
    }),
    runFrame: (time: number) => {
      const entry = frames.entries().next().value;
      if (entry === undefined) throw new Error("No frame is pending.");
      frames.delete(entry[0]);
      entry[1](time);
    },
    setInlineBlockSize: (value: string) => {
      inlineBlockSize = value;
    },
    setVisibleHeight: (height: number) => {
      visibleHeight = height;
    },
    onSettled,
    style,
  };
}
