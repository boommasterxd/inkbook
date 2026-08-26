// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import type { BrowserScrollElement } from "../../../../src/obsidian/scrolling/index";
import {
  LAYOUT_TRANSITION_CLASS,
  SCROLL_ANCHOR_SUPPRESSED_CLASS,
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
    fixture.shiftRootBy(24);
    const expectedTop = fixture.root.getBoundingClientRect().top;
    const releaseLock = fixture.stability.begin();
    fixture.flushFrame();

    expect(fixture.owner.scrollTop).toBe(1_400);
    expect(fixture.root.getBoundingClientRect().top).toBe(expectedTop);
    releaseLock();
    fixture.stability.dispose();
  });
});

function createFixture() {
  const root = htmlDiv();
  const owner = htmlDiv() as BrowserScrollElement;
  let rootDocumentTop = 1_800;
  Object.defineProperties(owner, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: { configurable: true, value: 3_000 },
  });
  owner.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
  root.getBoundingClientRect = () => new DOMRect(0, rootDocumentTop - owner.scrollTop, 800, 200);
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
  const stability = new TransitionScrollStability({ owner: () => owner, ownerWindow, root });
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
    root,
    shiftRootBy: (delta: number) => {
      rootDocumentTop += delta;
    },
    stability,
  };
}

function htmlDiv(): HTMLDivElement {
  return document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
}
