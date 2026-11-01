// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToolbarSpacing } from "../../../../../src/obsidian/embeds/active-scene/toolbar-spacing";
import { createPresentationMotionWindow } from "../../../../fixtures/obsidian/presentation-motion-window";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function createFixture() {
  installObsidianDomHelpers();
  const root = document.body.createDiv();
  root.setCssProps({ "--inkbook-toolbar-overlay-block-size": "68px" });
  const chrome = root.createDiv();
  const frames = createPresentationMotionWindow();
  let now = 0;
  const spacing = new ToolbarSpacing(
    root,
    chrome,
    workSchedulerFromFrames(frames.ownerWindow, { now: () => now }),
  );
  return {
    frames,
    root,
    spacing,
    height: () => Number.parseFloat(root.style.getPropertyValue("--inkbook-toolbar-spacing")),
    frame: (time: number) => {
      now = time;
      frames.frame(time);
    },
  };
}

describe("toolbar note-flow spacing", () => {
  it("opens and closes the space above the paper and retargets an interrupted close", () => {
    const fixture = createFixture();
    fixture.spacing.setOpen(true, false);
    fixture.frame(120);
    expect(fixture.height()).toBeGreaterThan(0);
    expect(fixture.height()).toBeLessThan(68);
    fixture.frame(240);
    expect(fixture.height()).toBe(68);
    expect(fixture.frames.frames.size).toBe(0);

    fixture.spacing.setOpen(false, false);
    fixture.frame(360);
    const interrupted = fixture.height();
    expect(interrupted).toBeGreaterThan(0);
    expect(interrupted).toBeLessThan(68);
    fixture.spacing.setOpen(true, false);
    expect(fixture.height()).toBe(interrupted);
    fixture.frame(600);
    expect(fixture.height()).toBe(68);
    fixture.spacing.setOpen(false, false);
    fixture.frame(840);
    expect(fixture.height()).toBe(0);
    expect(fixture.frames.frames.size).toBe(0);
    fixture.spacing.dispose();
  });

  it("settles reduced motion and releases pending work and spacing on disposal", () => {
    const fixture = createFixture();
    fixture.spacing.setOpen(true, true);
    expect(fixture.height()).toBe(68);
    expect(fixture.frames.frames.size).toBe(0);
    fixture.spacing.setOpen(false, false);
    fixture.frame(120);
    fixture.spacing.finish();
    expect(fixture.height()).toBe(0);
    fixture.spacing.setOpen(true, false);
    fixture.frame(180);
    fixture.spacing.setOpen(true, true);
    expect(fixture.height()).toBe(68);
    fixture.spacing.setOpen(false, false);
    fixture.spacing.dispose();
    expect(fixture.root.style.getPropertyValue("--inkbook-toolbar-spacing")).toBe("");
    expect(fixture.frames.frames.size).toBe(0);
  });

  it("reads the host spacing once and never measures ink or layout during interpolation", () => {
    const reads = vi.spyOn(window, "getComputedStyle");
    const geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const fixture = createFixture();
    expect(reads).toHaveBeenCalledTimes(1);
    fixture.spacing.setOpen(true, false);
    for (const time of [60, 120, 180, 240]) fixture.frame(time);
    fixture.spacing.setOpen(false, false);
    for (const time of [300, 360, 420, 480]) fixture.frame(time);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(geometry).not.toHaveBeenCalled();
    expect(fixture.frames.frames.size).toBe(0);
    fixture.spacing.dispose();
  });
});
