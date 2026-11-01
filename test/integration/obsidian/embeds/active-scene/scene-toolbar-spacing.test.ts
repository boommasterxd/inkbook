// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

import { ActiveScenePreviewHandoff } from "../../../../../src/obsidian/embeds/active-scene/active-scene-handoff";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { createPresentationMotionWindow } from "../../../../fixtures/obsidian/presentation-motion-window";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function createFixture(activeHeight = 240) {
  installObsidianDomHelpers();
  const frames = createPresentationMotionWindow();
  vi.spyOn(window, "matchMedia").mockImplementation((query) =>
    frames.ownerWindow.matchMedia(query),
  );
  const root = document.body.createDiv();
  root.setCssProps({ "--inkbook-toolbar-overlay-block-size": "68px" });
  const preview = root.createDiv();
  vi.spyOn(preview, "getBoundingClientRect").mockReturnValue({ height: 96 } as DOMRect);
  const editorChrome = root.createDiv();
  const container = editorChrome.createDiv();
  container.style.blockSize = `${String(activeHeight)}px`;
  const handoff = new ActiveScenePreviewHandoff({
    container,
    editorChrome,
    motion: "system",
    preview,
    root,
    workScheduler: workSchedulerFromFrames(frames.ownerWindow),
  });
  const ready = vi.fn();
  const reveal = vi.fn();
  handoff.onSceneReveal = reveal;
  handoff.ready(ready);
  frames.frame(16);
  return { frames, handoff, preview, ready, reveal, root };
}

it.each(["system", "device"] as const)(
  "reserves toolbar space when %s reduced motion interrupts unlock preparation",
  (source) => {
    const fixture = createFixture();
    expect(fixture.preview.hidden).toBe(false);
    expect(fixture.ready).not.toHaveBeenCalled();
    if (source === "system") fixture.frames.setReduced(true);
    else fixture.handoff.updateMotion("reduced");

    expect(fixture.root.style.getPropertyValue("--inkbook-toolbar-spacing")).toBe("68px");
    expect(fixture.root.classList.contains("inkbook-active-ready")).toBe(true);
    expect(fixture.root.classList.contains("inkbook-active-preparing")).toBe(false);
    expect(fixture.preview.hidden).toBe(true);
    expect(fixture.ready).toHaveBeenCalledOnce();
    expect(fixture.reveal).toHaveBeenCalledOnce();
    expect(fixture.frames.frames.size).toBe(0);
    fixture.handoff.dispose();
  },
);

it.each(["preparing", "active"])(
  "keeps a %s editor's closing target on reduced motion",
  (state) => {
    const fixture = createFixture();
    if (state === "active") {
      fixture.frames.frame(32);
      fixture.frames.frame(10_000);
      expect(fixture.root.style.getPropertyValue("--inkbook-toolbar-spacing")).toBe("68px");
    }
    fixture.handoff.stopUnlockHeight();
    fixture.frames.setReduced(true);

    expect(
      Number.parseFloat(fixture.root.style.getPropertyValue("--inkbook-toolbar-spacing") || "0"),
    ).toBe(0);
    expect(fixture.frames.frames.size).toBe(0);
    fixture.handoff.dispose();
  },
);
