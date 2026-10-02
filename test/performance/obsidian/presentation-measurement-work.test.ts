import { expect, it, vi } from "vitest";

import { PresentationController } from "../../../src/obsidian/embeds/presentation-controller";
import { ColorSchemeBroadcaster } from "../../../src/obsidian/theme/color-scheme";
import { FakePresentationElement } from "../../fixtures/obsidian/presentation-dom";
import { createPresentationMotionWindow } from "../../fixtures/obsidian/presentation-motion-window";
import { workSchedulerFromFrames } from "../../fixtures/obsidian/work-scheduler";

it("bounds root measurement across resize bursts and retained editor visibility changes", () => {
  const h = measurementHarness();
  h.controller.mount();
  h.flushFrames();

  for (const state of ["active", "locked", "active"] as const) {
    h.root.dataset.inkbookState = state;
    h.background.hidden = state === "locked";
    h.rootRead.mockClear();
    h.ownerRead.mockClear();
    h.styleRead.mockClear();
    for (let event = 0; event < 1_000; event += 1) h.resize();

    expect(h.rootRead).not.toHaveBeenCalled();
    expect(h.ownerRead).not.toHaveBeenCalled();
    expect(h.frames.size).toBe(2);
    h.flushFrames();
    expect(h.rootRead).toHaveBeenCalledOnce();
    expect(h.ownerRead).toHaveBeenCalledOnce();
    expect(
      h.styleRead.mock.calls.filter(([element]) => element === (h.root as unknown as HTMLElement)),
    ).toHaveLength(1);
    expect(h.styleRead.mock.calls.length).toBeLessThanOrEqual(2);
    expect(h.shellRadius()).toBe("14px");
    expect(h.frames.size).toBe(0);
  }

  expect(h.backgroundRead).not.toHaveBeenCalled();
  expect(h.backgroundQuery).not.toHaveBeenCalled();
  h.resize();
  expect(h.frames.size).toBe(2);
  h.controller.dispose();
  expect(h.frames.size).toBe(0);
  h.rootRead.mockClear();
  h.resize();
  h.flushFrames();
  expect(h.rootRead).not.toHaveBeenCalled();
  expect(h.frames.size).toBe(0);
});

function measurementHarness() {
  const owner = new FakePresentationElement();
  owner.clientWidth = 1_000;
  const root = new FakePresentationElement(owner.ownerDocument);
  owner.append(root);
  const background = root.createDiv({ cls: "inkbook-background-container" });
  const ownerWindow = root.ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("Missing owner window.");
  const motion = createPresentationMotionWindow();
  const { frames } = motion;
  Object.assign(ownerWindow, {
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      motion.ownerWindow.requestAnimationFrame(callback),
    cancelAnimationFrame: (id: number) => motion.ownerWindow.cancelAnimationFrame(id),
  });
  const rootRead = vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
    bottom: 100,
    height: 100,
    left: 0,
    right: 700,
    top: 0,
    width: 700,
  });
  const styles = new Map<string, string>();
  root.style.setProperty = (name, value) => styles.set(name, value);
  const controller = createController(root, ownerWindow);
  return {
    background,
    controller,
    frames,
    root,
    rootRead,
    backgroundQuery: vi.spyOn(root, "getElementsByClassName"),
    backgroundRead: vi.spyOn(background, "getBoundingClientRect"),
    ownerRead: vi.spyOn(owner, "getBoundingClientRect"),
    styleRead: vi.spyOn(ownerWindow, "getComputedStyle"),
    shellRadius: () => styles.get("--inkbook-shell-radius"),
    resize: () => ownerWindow.dispatchEvent(new Event("resize")),
    flushFrames: () => {
      for (let frame = 0; frames.size > 0 && frame < 3; frame += 1) {
        motion.frame(0);
      }
      expect(frames.size).toBe(0);
    },
  };
}

function createController(root: FakePresentationElement, ownerWindow: Window) {
  return new PresentationController(
    {
      attachmentGeneration: 1,
      attachmentId: "measurement-work",
      documentId: "drawings/ink.svg",
      embedReference: {
        documentId: "drawings/ink.svg",
        from: 4,
        kind: "live-preview",
        sourcePath: "notes/note.md",
        to: 28,
      },
      root: root as unknown as HTMLElement,
    },
    { activate: vi.fn(), detach: vi.fn(), mount: vi.fn() },
    new ColorSchemeBroadcaster({ getColorScheme: () => "light" }),
    undefined,
    workSchedulerFromFrames(ownerWindow),
  );
}
