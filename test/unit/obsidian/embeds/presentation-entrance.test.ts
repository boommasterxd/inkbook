// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { TRANSITION_DURATIONS } from "../../../../src/rendering/motion/transitions";
import { entranceHarness } from "./presentation-entrance-fixture";
import type { PresentationEntranceState } from "../../../../src/obsidian/embeds/presentation-entrance";

const duration = TRANSITION_DURATIONS.automaticPageGrowth;

describe("presentation remount continuity", () => {
  it.each([0, 90])(
    "continues a cancelled reveal after %s ms from its exact height",
    async (elapsed) => {
      const state: PresentationEntranceState = { presented: false };
      const first = entranceHarness(state);
      first.entrance.prepare();
      first.entrance.measure();
      first.frame(0);
      first.frame(elapsed);
      const height = first.renderedHeight;
      expect(state.presented).toBe(false);
      expect(state.initialHeight).toBe(height);
      const stale = [...first.frames.values()][0]!;
      first.entrance.dispose();
      const next = entranceHarness(state);
      next.entrance.prepare();
      expect(next.renderedHeight).toBe(height);
      next.entrance.measure();
      next.frame(0);
      next.frame(duration / 2);
      expect(next.renderedHeight).toBe((height + 400) / 2);
      stale(duration);
      expect(state.initialHeight).toBe(next.renderedHeight);
      next.frame(duration);
      await expect(next.entrance.ready).resolves.toBe(true);
      expect(state.presented).toBe(true);
      const completed = entranceHarness(state);
      completed.entrance.prepare();
      expect(completed.frames.size).toBe(0);
      await expect(completed.entrance.ready).resolves.toBe(true);
    },
  );

  it("finishes a remounted partial reveal immediately when motion becomes reduced", async () => {
    const state: PresentationEntranceState = { presented: false, initialHeight: 123 };
    const h = entranceHarness(state);
    h.setMotion("reduced");
    h.entrance.prepare();
    await expect(h.entrance.ready).resolves.toBe(true);
    expect(state.presented).toBe(true);
    expect(h.frames.size).toBe(0);
  });
});

describe("presentation entrance", () => {
  it.each([24, 400])("animates from the placeholder height to %s pixels", async (target) => {
    const h = entranceHarness({ presented: false, initialHeight: 48 });
    h.setHeight(target);
    h.entrance.prepare();
    expect(h.renderedHeight).toBe(48);
    h.entrance.measure();
    h.frame(0);
    h.frame(duration / 2);
    expect(h.renderedHeight).toBe((48 + target) / 2);
    expect(h.preview.getBoundingClientRect().height).toBe(target);
    h.frame(duration);
    await expect(h.entrance.ready).resolves.toBe(true);
    expect(h.root.style.length).toBe(0);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "ignores invalid placeholder height %s",
    (initialHeight) => {
      const h = entranceHarness({ presented: false, initialHeight });
      h.entrance.prepare();
      expect(h.renderedHeight).toBe(0);
      h.entrance.dispose();
    },
  );

  it("reveals from zero with smooth growth while preserving full preview geometry", async () => {
    const h = entranceHarness();
    h.entrance.prepare();
    expect(h.renderedHeight).toBe(0);
    expect(h.root.classList.contains("inkbook-presentation-entering")).toBe(true);
    h.entrance.measure();
    h.frame(0);
    h.frame(duration / 2);
    expect(h.renderedHeight).toBe(200);
    expect(h.preview.getBoundingClientRect().height).toBe(400);
    expect(h.preview.style.length).toBe(0);
    h.frame(duration);
    await expect(h.entrance.ready).resolves.toBe(true);
    expect(h.root.className).toBe("");
    expect(h.root.style.length).toBe(0);
    expect(h.listeners.size).toBe(0);
    expect(h.frames.size).toBe(0);
    expect(h.presented).toBe(1);
    h.entrance.prepare();
    h.entrance.measure();
    h.entrance.dispose();
    expect(h.frames.size).toBe(0);
    expect(h.presented).toBe(1);
  });

  it.each(["system", "reduced"] as const)(
    "settles immediately for %s reduced motion",
    async (motion) => {
      const h = entranceHarness();
      h.setMotion(motion);
      h.setSystemReduced(true);
      h.entrance.prepare();
      await expect(h.entrance.ready).resolves.toBe(true);
      expect(h.root.style.length).toBe(0);
      expect(h.frames.size).toBe(0);
    },
  );

  it("honors full motion over the system preference", () => {
    const h = entranceHarness();
    h.setMotion("full");
    h.setSystemReduced(true);
    h.entrance.prepare();
    h.entrance.measure();
    expect(h.entrance.pending).toBe(true);
    expect(h.frames.size).toBe(1);
    h.entrance.dispose();
  });

  it.each(["system", "preference"])("settles when %s changes during growth", async (change) => {
    const h = entranceHarness();
    h.entrance.prepare();
    h.entrance.measure();
    h.frame(0);
    if (change === "system") h.setSystemReduced(true);
    else {
      h.setMotion("reduced");
      h.frame(duration / 2);
    }
    await expect(h.entrance.ready).resolves.toBe(true);
    expect(h.frames.size).toBe(0);
    expect(h.listeners.size).toBe(0);
    expect(h.root.style.length).toBe(0);
  });
});

describe("presentation entrance lifecycle", () => {
  it("retargets a resized preview from the current height and cancels the old frame", async () => {
    const h = entranceHarness();
    h.entrance.prepare();
    h.entrance.measure();
    h.frame(0);
    h.frame(duration / 2);
    h.setHeight(600);
    h.entrance.measure();
    expect(h.frames.size).toBe(1);
    expect(h.renderedHeight).toBe(200);
    h.frame(duration);
    h.frame(duration * 1.5);
    expect(h.renderedHeight).toBe(400);
    h.frame(duration * 2);
    await expect(h.entrance.ready).resolves.toBe(true);
    expect(h.presented).toBe(1);
  });

  it("skips an already presented widget state", async () => {
    const h = entranceHarness({ presented: true });
    h.entrance.prepare();
    await expect(h.entrance.ready).resolves.toBe(true);
    expect(h.frames.size).toBe(0);
    expect(h.root.style.length).toBe(0);
  });

  it.each([false, true])("disposes safely with animation started=%s", async (started) => {
    const h = entranceHarness();
    h.entrance.prepare();
    if (started) {
      h.entrance.measure();
      h.frame(0);
    }
    h.entrance.dispose();
    await expect(h.entrance.ready).resolves.toBe(false);
    expect(h.frames.size).toBe(0);
    expect(h.listeners.size).toBe(0);
    expect(h.root.style.length).toBe(0);
    expect(h.root.className).toBe("");
    expect(h.presented).toBe(0);
  });

  it("ignores unavailable dimensions and unchanged targets", () => {
    const h = entranceHarness();
    h.entrance.prepare();
    for (const height of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      h.setHeight(height);
      h.entrance.measure();
      expect(h.frames.size).toBe(0);
    }
    h.setHeight(400);
    h.entrance.measure();
    const id = [...h.frames.keys()][0];
    h.setHeight(400.1);
    h.entrance.measure();
    expect([...h.frames.keys()]).toEqual([id]);
    h.entrance.dispose();
  });
});
