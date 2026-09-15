import { describe, expect, it } from "vitest";
import {
  readyResponsiveFixture,
  responsiveFixture,
} from "./active-editor-responsive-layout-fixture";

describe("active editor responsive layout", () => {
  it("skips toolbar reads for repeated chrome keys and non-width content updates", () => {
    const fixture = responsiveFixture();
    fixture.layout.chromeMounted();
    fixture.flushFrames();
    const initialReads = fixture.toolbarReads();

    fixture.layout.chromeChanged("wide:right:no-finger:no-selection:no-paste");
    fixture.flushFrames();
    const keyedReads = fixture.toolbarReads();
    expect(keyedReads).toBeGreaterThan(initialReads);

    fixture.layout.chromeChanged("wide:right:no-finger:no-selection:no-paste");
    fixture.layout.contentChanged();
    fixture.flushFrames();
    expect(fixture.toolbarReads()).toBe(keyedReads);
    fixture.layout.dispose();
  });

  it("remeasures the toolbar directly when its geometry changes at a fixed page width", () => {
    const fixture = responsiveFixture();
    fixture.layout.chromeMounted();
    fixture.flushFrames();

    expect(fixture.onLayout).toHaveBeenLastCalledWith("wide");
    expect(fixture.observed.has(fixture.root)).toBe(true);
    expect(fixture.observed.has(fixture.toolbar())).toBe(true);

    fixture.setToolbarWidth(900);
    fixture.triggerResize();
    fixture.flushFrames();

    expect(fixture.onLayout).toHaveBeenLastCalledWith("scrollable");
    fixture.layout.dispose();
  });

  it("keeps a centered wide toolbar when context-action geometry changes", () => {
    const fixture = responsiveFixture();
    fixture.layout.chromeMounted();
    fixture.flushFrames();

    expect(fixture.onLayout).toHaveBeenLastCalledWith("wide");
    fixture.triggerContextMutation();
    fixture.flushFrames();

    expect(fixture.onLayout).toHaveBeenLastCalledWith("wide");
    fixture.layout.dispose();
  });
});

it("skips toolbar and page-layout work for animated height-only root resizes", () => {
  const h = readyResponsiveFixture();
  const reads = h.toolbarReads();
  for (const height of [220, 240, 280, 320]) {
    h.triggerRootResize(700, height);
    h.flushFrames();
  }
  expect(h.toolbarReads()).toBe(reads);
  expect(h.onLayout).not.toHaveBeenCalled();
  expect(h.invalidateLayout).toHaveBeenCalledTimes(4);
  h.triggerRootResize(500, 320);
  h.flushFrames();
  expect(h.toolbarReads()).toBeGreaterThan(reads);
  expect(h.onLayout).toHaveBeenCalled();
  h.layout.dispose();
});

it("still measures observed toolbar changes after repeated root-height notifications", () => {
  const h = readyResponsiveFixture();
  const reads = h.toolbarReads();
  h.triggerRootResize(700, 300);
  h.triggerToolbarResize();
  h.flushFrames();
  expect(h.toolbarReads()).toBeGreaterThan(reads);
  h.layout.dispose();
});
