// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ActiveScenePreviewHandoff } from "../../../../../src/obsidian/embeds/active-scene/active-scene-handoff";
import { applyLockedFitLayout } from "../../../../../src/obsidian/embeds/active-scene/active-scene-lock";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { domRect } from "../../../../fixtures/obsidian/active-editor";
import { installPluginStyles } from "../../../../fixtures/obsidian/plugin-styles";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";

beforeEach(() => {
  installObsidianDomHelpers();
  installPluginStyles("inkbook");
});

afterEach(() => {
  document.body.replaceChildren();
  document.adoptedStyleSheets = [];
  vi.restoreAllMocks();
});

it.each(["complete", "reduced", "dispose"])(
  "keeps the exact preview behind the editor and releases stacking on %s",
  (completion) => {
    const fixture = createFixture();
    const preview = fixture.root.createDiv({ cls: "inkbook-locked-preview" });
    const editor = fixture.root.createDiv({ cls: "inkbook-editor-chrome" });
    preview.hidden = true;
    const handoff = new ActiveScenePreviewHandoff({
      container: fixture.container,
      motion: "reduced",
      preview,
      root: fixture.root,
      workScheduler: fixture.scheduler,
    });
    const complete = vi.fn();
    handoff.ready();
    handoff.updateMotion("full");

    handoff.handoffToPreview(editor, complete);
    expect(preview.hidden).toBe(false);
    expect(window.getComputedStyle(preview).position).toBe("absolute");
    expect(window.getComputedStyle(preview).zIndex).toBe("1");
    expect(window.getComputedStyle(editor).zIndex).toBe("2");
    expect(editor.hidden).toBe(false);
    fixture.runFrame();
    expect(complete).not.toHaveBeenCalled();
    expect(editor.hidden).toBe(false);

    if (completion === "dispose") handoff.dispose();
    else if (completion === "reduced") handoff.updateMotion("reduced");
    else fixture.runFrame();

    expect(window.getComputedStyle(preview).position).toBe("relative");
    expect(window.getComputedStyle(editor).zIndex).toBe("1");
    expect(preview.hidden).toBe(false);
    if (completion !== "dispose") expect(editor.hidden).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
    expect(fixture.frames.size).toBe(0);
    handoff.dispose();
  },
);

it.each(["complete", "cancel"])("releases lock sizing suppression on %s", (completion) => {
  const fixture = createFixture();
  const initial = window.getComputedStyle(fixture.container).transition;
  const transition = applyLockedFitLayout({
    anchor: undefined,
    applyResize: () => true,
    container: fixture.container,
    maximumBottom: undefined,
    oldViewState: { cameraX: 0, zoom: 1 },
    page: {
      activeBufferLines: 3,
      background: { spacing: 25, type: "lines" },
      innerWidth: 2_000,
      lockedBufferLines: 1,
      margin: 24.3,
    },
    reducedMotion: false,
    restoreViewState: () => true,
    workScheduler: fixture.scheduler,
  });

  expect(window.getComputedStyle(fixture.container).transition).toBe("none");
  if (completion === "cancel") transition.cancel();
  else transition.finish();
  expect(window.getComputedStyle(fixture.container).transition).toBe(initial);
  expect(fixture.container.style.transition).toBe("");
  expect(fixture.frames.size).toBe(0);
});

function createFixture() {
  const root = document.body.createDiv({ cls: "inkbook-root inkbook-embed-root" });
  const container = root.createDiv({ cls: "inkbook-background-container" });
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
    domRect({ height: 480, left: 0, top: 0, width: 1_024 }),
  );
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const scheduler = workSchedulerFromFrames(
    {
      requestAnimationFrame: (callback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      },
      cancelAnimationFrame: (id) => frames.delete(id),
    },
    { now: () => 0 },
  );
  return {
    container,
    frames,
    root,
    scheduler,
    runFrame: () => {
      const entry = frames.entries().next().value;
      if (entry === undefined) throw new Error("No frame is pending.");
      frames.delete(entry[0]);
      entry[1](0);
    },
  };
}
