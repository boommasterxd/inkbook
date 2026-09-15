// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { TRANSITION_DURATIONS } from "../../../../src/rendering/motion/transitions";
import { exitHarness } from "./presentation-exit-fixture";

const duration = TRANSITION_DURATIONS.automaticPageGrowth;

describe("presentation exit", () => {
  it("reverses the reveal and retains the collapsed inert root until disposal", async () => {
    const h = exitHarness();
    const ready = h.exit.begin();
    expect(h.height).toBe(400);
    expect(h.root.inert).toBe(true);
    h.frame(0);
    h.frame(duration / 2);
    expect(h.height).toBe(200);
    expect(h.root.getBoundingClientRect().height).toBe(400);
    h.frame(duration);
    await expect(ready).resolves.toBe(true);
    expect(h.height).toBe(0);
    expect(h.frames.size).toBe(0);
    expect(h.listeners.size).toBe(0);
    h.exit.dispose();
    expect(h.root.className).toBe("");
    expect(h.root.style.length).toBe(0);
    expect(h.root.inert).toBe(false);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "skips unavailable height %s",
    async (height) => {
      const h = exitHarness(height);
      await expect(h.exit.begin()).resolves.toBe(true);
      expect(h.frames.size).toBe(0);
    },
  );

  it.each(["system", "reduced"] as const)("skips %s reduced motion", async (motion) => {
    const h = exitHarness();
    h.setMotion(motion);
    h.setReduced(true);
    await expect(h.exit.begin()).resolves.toBe(true);
    expect(h.frames.size).toBe(0);
    expect(h.root.style.length).toBe(0);
  });

  it.each(["system", "preference"])("settles a running exit when %s changes", async (change) => {
    const h = exitHarness();
    const ready = h.exit.begin();
    h.frame(0);
    if (change === "system") h.setReduced(true);
    else {
      h.setMotion("reduced");
      h.frame(duration / 2);
    }
    await expect(ready).resolves.toBe(true);
    expect(h.height).toBe(0);
    expect(h.frames.size).toBe(0);
    h.exit.dispose();
  });

  it("honors full motion and restores pre-existing inert state on reset", async () => {
    const h = exitHarness();
    h.root.inert = true;
    h.setMotion("full");
    h.setReduced(true);
    const ready = h.exit.begin();
    await expect(h.exit.begin()).resolves.toBe(false);
    h.frame(0);
    const stale = [...h.frames.values()][0]!;
    h.exit.reset();
    await expect(ready).resolves.toBe(false);
    stale(duration);
    expect(h.root.inert).toBe(true);
    expect(h.frames.size).toBe(0);
    expect(h.listeners.size).toBe(0);
    expect(h.root.style.length).toBe(0);
    h.exit.dispose();
    await expect(h.exit.begin()).resolves.toBe(false);
  });
});

it.each([
  { before: 0, after: 0 },
  { before: 24, after: 0 },
  { before: 0, after: 24 },
  { before: 24, after: 24 },
  { before: Number.NaN, after: -1 },
])("collapses surrounding spacing independently: %j", async (spacing) => {
  const h = exitHarness(400, spacing);
  const ready = h.exit.begin();
  h.frame(0);
  for (const fraction of [0.5, 1]) {
    h.frame(duration * fraction);
    for (const side of ["before", "after"] as const) {
      const value = spacing[side];
      const expected = Number.isFinite(value) ? Math.max(0, value) : 0;
      expect(
        Number.parseFloat(h.root.style.getPropertyValue(`--inkbook-presentation-exit-${side}`)),
      ).toBe(expected === 0 ? 0 : -expected * fraction);
    }
  }
  await expect(ready).resolves.toBe(true);
  h.exit.reset();
  expect(h.root.style.length).toBe(0);
});

it("preserves unrelated layout work when a confirmation is cancelled before exit", () => {
  const h = exitHarness();
  h.root.className = "inkbook-layout-transitioning inkbook-page-height-transitioning";
  h.exit.reset();
  expect(h.root.className).toBe("inkbook-layout-transitioning inkbook-page-height-transitioning");
});

it("allows only the owned live presentation to mutate Markdown", () => {
  const remove = vi.fn(() => true);
  const h = exitHarness(400, { before: 0, after: 0 }, remove);
  const range = { from: 0, to: 3 };
  const mutate = vi.fn();
  expect(h.exit.removeMarkdown(range, "abc", mutate)).toBe(true);
  expect(remove).toHaveBeenCalledExactlyOnceWith(range, "abc", mutate);
  h.exit.dispose();
  expect(h.exit.removeMarkdown(range, "abc", mutate)).toBe(false);
  expect(remove).toHaveBeenCalledOnce();
  expect(exitHarness().exit.removeMarkdown(range, "abc", mutate)).toBeUndefined();
});
