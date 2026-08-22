import { describe, expect, it, vi } from "vitest";

import {
  createFlyoutPositionLifecycle,
  positionFlyoutPanel,
  resolveVisibleOwnerBoundary,
  resolveFlyoutPosition,
} from "../../../../src/rendering/ui/flyout-position";

const trigger = { bottom: 84, height: 44, left: 80, right: 124, top: 40, width: 44 };

describe("flyout position", () => {
  it("places a flyout below its trigger when space is available", () => {
    expect(
      resolveFlyoutPosition({
        boundaryHeight: 600,
        boundaryWidth: 800,
        flyoutHeight: 200,
        flyoutWidth: 240,
        trigger,
      }),
    ).toEqual({ left: 80, top: 92 });
  });

  it("flips above and clamps to the visible owner-document boundary", () => {
    expect(
      resolveFlyoutPosition({
        boundaryHeight: 300,
        boundaryWidth: 260,
        flyoutHeight: 180,
        flyoutWidth: 240,
        trigger: { ...trigger, bottom: 284, left: 180, top: 240 },
      }),
    ).toEqual({ left: 12, top: 52 });
  });

  it("keeps oversized flyouts inside the leading and top margins", () => {
    expect(
      resolveFlyoutPosition({
        boundaryHeight: 120,
        boundaryWidth: 160,
        flyoutHeight: 200,
        flyoutWidth: 240,
        trigger,
      }),
    ).toEqual({ left: 8, top: 8 });
  });

  it("applies the clamped position to a portal panel", () => {
    const style = { left: "", top: "" };
    const panel = { offsetHeight: 200, offsetWidth: 240, style } as HTMLElement;
    const anchor = { getBoundingClientRect: () => trigger } as unknown as HTMLElement;
    const ownerDocument = {
      documentElement: { clientHeight: 600, clientWidth: 800 },
    } as unknown as Document;

    positionFlyoutPanel(panel, anchor, ownerDocument);
    expect(style).toEqual({
      left: "80px",
      maxBlockSize: "584px",
      maxInlineSize: "784px",
      top: "92px",
    });
  });
});

describe("flyout position lifecycle", () => {
  it("clamps to the visible scroll-owner client box instead of the complete viewport", () => {
    const owner = {
      clientHeight: 220,
      clientLeft: 2,
      clientTop: 3,
      clientWidth: 300,
      getBoundingClientRect: () => ({ left: 90, top: 40 }),
      parentElement: null,
      scrollHeight: 500,
    } as unknown as HTMLElement;
    const anchor = { parentElement: owner } as HTMLElement;
    const ownerDocument = {
      defaultView: { getComputedStyle: () => ({ overflowY: "auto" }) },
      documentElement: { clientHeight: 600, clientWidth: 800 },
      scrollingElement: null,
    } as unknown as Document;

    expect(resolveVisibleOwnerBoundary(anchor, ownerDocument)).toEqual({
      bottom: 263,
      left: 92,
      right: 392,
      top: 43,
    });
  });

  it("repositions through lifecycle-owned scroll, resize, and content observers", () => {
    const ownerDocument = new EventTarget() as Document & EventTarget;
    const owningWindow = new EventTarget() as Window & EventTarget;
    let frame: FrameRequestCallback | undefined;
    let resize: (() => void) | undefined;
    let triggerLeft = 80;
    const panel = {
      offsetHeight: 160,
      offsetWidth: 220,
      style: { left: "", top: "" },
    } as HTMLElement;
    const triggerElement = {
      getBoundingClientRect: () => ({ ...trigger, left: triggerLeft }),
      parentElement: null,
    } as unknown as HTMLElement;
    Object.assign(owningWindow, {
      ResizeObserver: class {
        public constructor(callback: () => void) {
          resize = callback;
        }
        public disconnect(): void {}
        public observe(): void {}
      },
      cancelAnimationFrame: vi.fn(),
      getComputedStyle: () => ({ overflowY: "visible" }),
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frame = callback;
        return 1;
      },
    });
    Object.assign(ownerDocument, {
      defaultView: owningWindow,
      documentElement: { clientHeight: 600, clientWidth: 800 },
      scrollingElement: null,
    });
    const lifecycle = createFlyoutPositionLifecycle(panel, triggerElement, ownerDocument);
    expect(panel.style.left).toBe("80px");

    triggerLeft = 120;
    ownerDocument.dispatchEvent(new Event("scroll"));
    frame?.(0);
    expect(panel.style.left).toBe("120px");

    triggerLeft = 160;
    resize?.();
    frame?.(0);
    expect(panel.style.left).toBe("160px");
    lifecycle.dispose();
  });
});
