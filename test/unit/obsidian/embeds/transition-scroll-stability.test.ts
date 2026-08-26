// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import type { BrowserScrollElement } from "../../../../src/obsidian/scrolling/index";
import {
  LAYOUT_TRANSITION_CLASS,
  PresentationScrollRangeReserve,
  SCROLL_ANCHOR_SUPPRESSED_CLASS,
  SCROLL_RANGE_RESERVE_CLASS,
  TransitionScrollStability,
} from "../../../../src/obsidian/embeds/transition-scroll-stability";

describe("transition scroll stability", () => {
  it("restores host anchoring drift until the transition settles", () => {
    const fixture = createFixture();
    fixture.owner.scrollTop = 320;

    const release = fixture.stability.begin();
    fixture.owner.scrollTop = 365;
    fixture.owner.dispatchEvent(new Event("scroll"));

    expect(fixture.owner.scrollTop).toBe(320);
    fixture.flushFrame();

    expect(fixture.owner.scrollTop).toBe(320);
    expect(fixture.root.classList.contains(LAYOUT_TRANSITION_CLASS)).toBe(true);
    expect(fixture.owner.classList.contains(SCROLL_ANCHOR_SUPPRESSED_CLASS)).toBe(true);

    release();
    expect(fixture.root.classList.contains(LAYOUT_TRANSITION_CLASS)).toBe(false);
    fixture.flushFrames();
    expect(fixture.owner.classList.contains(SCROLL_ANCHOR_SUPPRESSED_CLASS)).toBe(false);
    fixture.stability.dispose();
  });

  it("keeps the embed at the same viewport position when preceding layout moves", () => {
    const fixture = createFixture();
    fixture.owner.scrollTop = 320;
    fixture.stability.begin();
    const initialTop = fixture.root.getBoundingClientRect().top;

    fixture.shiftRootBy(24);
    fixture.flushFrame();

    expect(fixture.owner.scrollTop).toBe(344);
    expect(fixture.root.getBoundingClientRect().top).toBe(initialTop);
    fixture.stability.dispose();
  });

  it("undoes bottom-pinning scroll synchronously during locked-to-editor growth", () => {
    const fixture = createFixture();
    fixture.owner.scrollTop = 1_400;
    fixture.stability.begin();
    const initialTop = fixture.root.getBoundingClientRect().top;

    fixture.owner.scrollTop = 1_640;
    fixture.owner.dispatchEvent(new Event("scroll"));

    expect(fixture.owner.scrollTop).toBe(1_400);
    expect(fixture.root.getBoundingClientRect().top).toBe(initialTop);
    fixture.stability.dispose();
  });
});

describe("transition scroll stability at the bottom boundary", () => {
  it("bridges consecutive bottom-boundary range dips through host settlement", async () => {
    const fixture = createFixture({ clampScrollTop: true, scrollHeight: 2_000 });
    fixture.owner.scrollTop = 1_400;
    const release = fixture.stability.begin();
    const initialTop = fixture.root.getBoundingClientRect().top;

    fixture.setNaturalScrollHeight(1_995);
    expect(fixture.owner.scrollTop).toBe(1_395);
    fixture.flushFrame();

    const reserve = fixture.root.querySelector<HTMLElement>(`.${SCROLL_RANGE_RESERVE_CLASS}`);
    expect(reserve?.style.blockSize).toBe("5px");
    expect(fixture.owner.scrollTop).toBe(1_400);
    expect(fixture.root.getBoundingClientRect().top).toBe(initialTop);

    fixture.setNaturalScrollHeight(1_993);
    fixture.flushFrame();

    expect(reserve?.style.blockSize).toBe("7px");
    expect(fixture.owner.scrollTop).toBe(1_400);
    expect(fixture.root.getBoundingClientRect().top).toBe(initialTop);

    release();
    const settled = fixture.stability.waitForSettlement();
    fixture.flushFrame();

    expect(fixture.root.querySelector(`.${SCROLL_RANGE_RESERVE_CLASS}`)).not.toBeNull();
    expect(fixture.owner.classList.contains(SCROLL_ANCHOR_SUPPRESSED_CLASS)).toBe(true);
    fixture.setNaturalScrollHeight(2_000);
    fixture.flushFrames();
    await settled;

    expect(fixture.root.querySelector(`.${SCROLL_RANGE_RESERVE_CLASS}`)).toBeNull();
    expect(fixture.owner.scrollTop).toBe(1_400);
    expect(fixture.root.getBoundingClientRect().top).toBe(initialTop);
    expect(fixture.owner.classList.contains(SCROLL_ANCHOR_SUPPRESSED_CLASS)).toBe(false);
    fixture.stability.dispose();
  });

  it("removes a bottom-boundary reserve when user scrolling takes over", () => {
    const fixture = createFixture({ clampScrollTop: true, scrollHeight: 2_000 });
    fixture.owner.scrollTop = 1_400;
    fixture.stability.begin();
    fixture.setNaturalScrollHeight(1_995);
    fixture.flushFrame();

    expectWheelReleasesReserve(fixture, 1_395);
    fixture.stability.dispose();
  });
});

describe("transition scroll stability across a persistent bottom boundary", () => {
  it("retains a permanent lock-shrink reserve until deliberate user scrolling", async () => {
    const fixture = createFixture({
      clampScrollTop: true,
      reserveOffsetAware: true,
      rootDocumentTop: 1_300,
      scrollHeight: 2_000,
    });
    fixture.owner.scrollTop = 1_400;
    const initialTop = fixture.root.getBoundingClientRect().top;
    const release = fixture.stability.begin(100);
    const reserve = fixture.root.querySelector<HTMLElement>(`.${SCROLL_RANGE_RESERVE_CLASS}`);

    expect(reserve?.style.blockSize).toBe("600px");

    for (const [naturalHeight, rootHeight] of [
      [1_980, 180],
      [1_950, 150],
      [1_900, 100],
    ] as const) {
      fixture.setNaturalScrollHeight(naturalHeight);
      fixture.setRootHeight(rootHeight);
      fixture.flushFrame();
      expect(fixture.owner.scrollTop).toBe(1_400);
      expect(fixture.root.getBoundingClientRect().top).toBe(initialTop);
    }

    await releaseAndSettle(fixture, release);

    expect(fixture.root.querySelector(`.${SCROLL_RANGE_RESERVE_CLASS}`)).not.toBeNull();
    expect(fixture.owner.scrollTop).toBe(1_400);
    expect(fixture.root.getBoundingClientRect().top).toBe(initialTop);
    expect(fixture.owner.classList.contains(SCROLL_ANCHOR_SUPPRESSED_CLASS)).toBe(false);

    expectWheelReleasesReserve(fixture, 1_300);
    fixture.stability.dispose();
  });

  it("adopts a retained lock reserve until unlock growth restores the natural range", async () => {
    const fixture = createFixture({
      clampScrollTop: true,
      reserveOffsetAware: true,
      rootDocumentTop: 1_300,
      scrollHeight: 2_000,
    });
    fixture.owner.scrollTop = 1_400;
    const releaseLock = fixture.stability.begin(100);
    fixture.setNaturalScrollHeight(1_900);
    fixture.setRootHeight(100);
    fixture.flushFrame();
    releaseLock();
    fixture.flushFrames();

    const releaseUnlock = fixture.stability.begin();
    fixture.setNaturalScrollHeight(2_000);
    fixture.setRootHeight(200);
    fixture.flushFrame();
    await releaseAndSettle(fixture, releaseUnlock);

    expect(fixture.root.querySelector(`.${SCROLL_RANGE_RESERVE_CLASS}`)).toBeNull();
    expect(fixture.owner.scrollTop).toBe(1_400);
    expect(fixture.root.getBoundingClientRect().top).toBe(-100);
    fixture.stability.dispose();
  });
});

describe("transition scroll stability ownership", () => {
  it("lets deliberate user scrolling take over during the animation", () => {
    const fixture = createFixture();
    fixture.owner.scrollTop = 320;
    fixture.stability.begin();

    fixture.owner.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    fixture.owner.scrollTop = 410;
    fixture.owner.dispatchEvent(new Event("scroll"));
    fixture.flushFrame();

    expect(fixture.owner.scrollTop).toBe(410);
    fixture.stability.dispose();
  });

  it("keeps stabilization active until the final nested lease is released", () => {
    const fixture = createFixture();
    const first = fixture.stability.begin();
    const second = fixture.stability.begin();

    first();
    expect(fixture.root.classList.contains(LAYOUT_TRANSITION_CLASS)).toBe(true);
    second();
    expect(fixture.root.classList.contains(LAYOUT_TRANSITION_CLASS)).toBe(false);
    fixture.stability.dispose();
  });

  it("recaptures the viewport anchor when a transition restarts during settlement", () => {
    const fixture = createFixture();
    fixture.owner.scrollTop = 1_400;
    const releaseUnlock = fixture.stability.begin();

    releaseUnlock();
    const settlementFrame = fixture.pendingFrameIds()[0];
    fixture.shiftRootBy(24);
    const expectedTop = fixture.root.getBoundingClientRect().top;
    const releaseLock = fixture.stability.begin();
    expect(fixture.pendingFrames()).toBe(1);
    expect(fixture.pendingFrameIds()[0]).not.toBe(settlementFrame);
    fixture.flushFrame();

    expect(fixture.owner.scrollTop).toBe(1_400);
    expect(fixture.root.getBoundingClientRect().top).toBe(expectedTop);
    releaseLock();
    fixture.stability.dispose();
  });
});

interface FixtureOptions {
  readonly clampScrollTop?: boolean;
  readonly reserveOffsetAware?: boolean;
  readonly rootDocumentTop?: number;
  readonly scrollHeight?: number;
}

function createFixture(options: FixtureOptions = {}) {
  const root = htmlDiv();
  root.createSpan = () => {
    const span = htmlSpan();
    root.append(span);
    return span;
  };
  const owner = htmlDiv() as BrowserScrollElement;
  let rootDocumentTop = options.rootDocumentTop ?? 1_800;
  let rootHeight = 200;
  let naturalScrollHeight = options.scrollHeight ?? 3_000;
  let scrollTop = 0;
  const effectiveScrollHeight = (): number =>
    options.reserveOffsetAware === true
      ? Math.max(naturalScrollHeight, rootDocumentTop + rootHeight + reserveSize(root))
      : naturalScrollHeight + reserveSize(root);
  const maximumScrollTop = (): number => {
    return Math.max(0, effectiveScrollHeight() - 600);
  };
  Object.defineProperties(owner, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: { configurable: true, get: effectiveScrollHeight },
    scrollTop: {
      configurable: true,
      get: () => {
        if (options.clampScrollTop === true) scrollTop = Math.min(scrollTop, maximumScrollTop());
        return scrollTop;
      },
      set: (value: number) => {
        scrollTop =
          options.clampScrollTop === true
            ? Math.min(maximumScrollTop(), Math.max(0, value))
            : value;
      },
    },
  });
  owner.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
  root.getBoundingClientRect = () =>
    new DOMRect(0, rootDocumentTop - owner.scrollTop, 800, rootHeight);
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const ownerWindow = {
    cancelAnimationFrame: (frame: number) => void frames.delete(frame),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const frame = nextFrame;
      nextFrame += 1;
      frames.set(frame, callback);
      return frame;
    },
  } as unknown as Window;
  const rangeReserve = new PresentationScrollRangeReserve(() => owner);
  const stability = new TransitionScrollStability({
    owner: () => owner,
    ownerWindow,
    rangeReserve,
    root,
  });
  const flushFrame = (): void => {
    const entry = frames.entries().next().value;
    if (entry === undefined) throw new Error("No frame is pending.");
    frames.delete(entry[0]);
    entry[1](0);
  };
  return {
    flushFrame,
    flushFrames: () => {
      while (frames.size > 0) flushFrame();
    },
    owner,
    pendingFrameIds: () => [...frames.keys()],
    pendingFrames: () => frames.size,
    root,
    setNaturalScrollHeight: (height: number) => {
      naturalScrollHeight = height;
    },
    setRootHeight: (height: number) => {
      rootHeight = height;
    },
    shiftRootBy: (delta: number) => {
      rootDocumentTop += delta;
    },
    stability,
  };
}

function reserveSize(root: HTMLElement): number {
  const reserve = root.querySelector<HTMLElement>(`.${SCROLL_RANGE_RESERVE_CLASS}`);
  const parsed = Number.parseFloat(reserve?.style.blockSize ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

async function releaseAndSettle(
  fixture: ReturnType<typeof createFixture>,
  release: () => void,
): Promise<void> {
  release();
  const settled = fixture.stability.waitForSettlement();
  fixture.flushFrames();
  await settled;
}

function expectWheelReleasesReserve(
  fixture: ReturnType<typeof createFixture>,
  expectedScrollTop: number,
): void {
  fixture.owner.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
  expect(fixture.root.querySelector(`.${SCROLL_RANGE_RESERVE_CLASS}`)).toBeNull();
  expect(fixture.owner.scrollTop).toBe(expectedScrollTop);
}

function htmlDiv(): HTMLDivElement {
  return document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
}

function htmlSpan(): HTMLSpanElement {
  return document.createElementNS("http://www.w3.org/1999/xhtml", "span");
}
