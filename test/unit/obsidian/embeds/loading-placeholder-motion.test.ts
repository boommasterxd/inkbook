import { describe, expect, it, vi } from "vitest";

import { LoadingPlaceholderMotion } from "../../../../src/obsidian/embeds/loading-placeholder-motion";
import type { MotionPreference } from "../../../../src/rendering/motion/transitions";
import { createPresentationMotionWindow } from "../../../fixtures/obsidian/presentation-motion-window";
import { FakePresentationElement } from "../../../fixtures/obsidian/presentation-dom";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";

function harness(options: { initialHeight?: number; motion?: MotionPreference } = {}) {
  const root = new FakePresentationElement();
  const clock = createPresentationMotionWindow();
  Object.assign(root.ownerDocument.defaultView!, clock.ownerWindow);
  const onHeight = vi.fn();
  const motion = new LoadingPlaceholderMotion(root as unknown as HTMLElement, {
    ...options,
    motion: options.motion ?? "system",
    onHeight,
    workScheduler: workSchedulerFromFrames(clock.ownerWindow),
  });
  return { ...clock, motion, onHeight, root };
}

function expectSettled(h: ReturnType<typeof harness>): void {
  expect(h.motion.renderedHeight).toBe(48);
  expect(h.frames.size).toBe(0);
  expect(h.listeners.size).toBe(0);
  expect(h.root.classNames.size).toBe(0);
}

describe("loading placeholder reveal", () => {
  it("starts at zero before paint and uses 180 ms smoothstep growth", () => {
    const h = harness();
    expect(h.motion.renderedHeight).toBe(0);
    expect(h.onHeight).toHaveBeenLastCalledWith(0);
    expect(h.root.style["--inkbook-loading-block-size" as keyof typeof h.root.style]).toBe("0px");
    h.frame(0);
    h.frame(45);
    expect(h.motion.renderedHeight).toBe(7.5);
    h.frame(90);
    expect(h.motion.renderedHeight).toBe(24);
    expect(h.onHeight).toHaveBeenLastCalledWith(24);
    h.frame(180);
    expectSettled(h);
  });

  it("continues from the exact retained partial height on remount", () => {
    const h = harness({ initialHeight: 12 });
    expect(h.motion.renderedHeight).toBe(12);
    h.frame(0);
    h.frame(90);
    expect(h.motion.renderedHeight).toBe(30);
    h.motion.dispose();
    expect(h.motion.renderedHeight).toBe(30);
    expect(h.frames.size).toBe(0);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "normalizes invalid initial height %s",
    (initialHeight) => {
      const h = harness({ initialHeight });
      expect(h.motion.renderedHeight).toBe(0);
      h.motion.dispose();
    },
  );

  it.each([48, 100])("does not replay a completed height %s", (initialHeight) => {
    const h = harness({ initialHeight });
    expect(h.motion.renderedHeight).toBe(48);
    expect(h.frames.size).toBe(0);
    h.motion.dispose();
  });

  it("uses the final height synchronously for reduced motion", () => {
    const h = harness({ motion: "reduced" });
    expect(h.motion.renderedHeight).toBe(48);
    expect(h.onHeight).toHaveBeenCalledExactlyOnceWith(48);
    expect(h.frames.size).toBe(0);
    expect(h.listeners.size).toBe(0);
  });

  it("settles when system reduced motion becomes active mid-transition", () => {
    const h = harness();
    h.frame(0);
    h.frame(90);
    h.setReduced(true);
    expectSettled(h);
  });

  it("keeps explicit full motion despite a changed system preference", () => {
    const h = harness({ motion: "full" });
    h.setReduced(true);
    expect(h.motion.renderedHeight).toBe(0);
    expect(h.frames.size).toBe(1);
    h.motion.dispose();
  });

  it("retains exact zero on early handoff and rejects late frame callbacks", () => {
    const h = harness();
    const staleFrame = [...h.frames.values()][0]!;
    h.motion.dispose();
    h.motion.dispose();
    staleFrame(90);
    expect(h.motion.renderedHeight).toBe(0);
    expect(h.onHeight).toHaveBeenCalledExactlyOnceWith(0);
    expect(h.frames.size).toBe(0);
    expect(h.listeners.size).toBe(0);
  });
});
