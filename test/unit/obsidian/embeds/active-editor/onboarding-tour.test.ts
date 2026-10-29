// @vitest-environment happy-dom
import "../../../../fixtures/obsidian/menu-motion";

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ONBOARDING_STEPS } from "../../../../../src/obsidian/embeds/active-editor/onboarding-steps";
import { OnboardingTour } from "../../../../../src/obsidian/embeds/active-editor/onboarding-tour";
import * as elementMotion from "../../../../../src/obsidian/runtime/element-motion";
import { AdaptivePanelSession } from "../../../../../src/obsidian/menus/panels/adaptive-panel";
import { createHtmlElement, installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";

const tours: OnboardingTour[] = [];
beforeEach(installObsidianDomHelpers);
afterEach(() => {
  tours.splice(0).forEach((tour) => tour.dispose());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture(
  width = 1200,
  minimum = "80px",
  fingerDrawing = false,
  deferPreview = false,
  layoutHeight?: number,
) {
  const root = createHtmlElement("div");
  root.dataset.inkbookMotion = "reduced";
  root.getBoundingClientRect = () => new DOMRect(0, 60, width, 600);
  const paper = root.createDiv({ cls: "inkbook-background-container" });
  paper.style.setProperty("min-block-size", minimum);
  if (layoutHeight !== undefined) paper.style.blockSize = `${String(layoutHeight)}px`;
  paper.getBoundingClientRect = () => root.getBoundingClientRect();
  const source = root.createEl("button", { text: "More options" });
  const canvas = root.createEl("button", { text: "Canvas" });
  const toolbarAction = vi.fn();
  const toolbar = root.createDiv({ cls: "inkbook-toolbar-composition" });
  const addTarget = (action: string, preview = false) => {
    const target = toolbar.createEl("button", { text: action });
    target.dataset.inkbookAction = action;
    target.getBoundingClientRect = () => new DOMRect(100, 100, 44, 44);
    target.addEventListener("click", toolbarAction);
    if (preview) {
      target.dataset.inkbookTourPreview = "true";
      target.disabled = true;
    }
    return target;
  };
  const targets = new Set<string>();
  for (const step of ONBOARDING_STEPS) {
    if (!step.previewContext && (!step.optional || fingerDrawing) && !targets.has(step.action)) {
      addTarget(step.action);
      targets.add(step.action);
    }
  }
  const syncPreview = (visible: boolean) => {
    toolbar.querySelectorAll('[data-inkbook-tour-preview="true"]').forEach((item) => item.remove());
    if (visible)
      for (const step of ONBOARDING_STEPS) {
        if (step.previewContext) addTarget(step.action, true);
      }
  };
  document.body.append(root);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const scheduler = workSchedulerFromFrames({
    requestAnimationFrame: (callback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
  });
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  };
  const onStateChanged = vi.fn(() => {
    if (!deferPreview || !tour.contextPreview) syncPreview(tour.contextPreview);
  });
  const tour = new OnboardingTour({
    root,
    canvasInputSurface: canvas,
    workScheduler: scheduler,
    onStateChanged,
  });
  tours.push(tour);
  return {
    root,
    paper,
    source,
    canvas,
    toolbarAction,
    tour,
    flush,
    frames,
    scheduler,
    toolbar,
    onStateChanged,
    syncPreview,
  };
}

function note(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

function click(label: string): void {
  const button = [...(note()?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  expect(button).toBeDefined();
  button?.click();
}

function description(): string | undefined {
  const current = note();
  return (
    current?.ownerDocument.getElementById(current.getAttribute("aria-labelledby") ?? "")
      ?.textContent ?? undefined
  );
}

const NORMAL_ACTIONS = [
  "undo",
  "select",
  "eraser",
  "draw",
  "highlighter",
  "straight-highlighter",
  "shape",
  "shape-picker",
  "style",
  "lock",
  "overflow",
  "paste",
  "copy",
  "cut",
  "delete",
  "overflow",
];

function expectStep(action: string, index: number, total: number): void {
  const steps = ONBOARDING_STEPS.filter((step) => !step.optional || total > NORMAL_ACTIONS.length);
  expect(steps[index]?.action).toBe(action);
  expect(description()).toBe(steps[index]?.description);
  expect(
    note()?.querySelector(`[aria-label="Step ${String(index + 1)} of ${String(total)}"]`)
      ?.textContent,
  ).toBe(`${String(index + 1)}/${String(total)}`);
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    index === total - 1 ? "Done" : "Next",
  );
}

function goTo(index: number): void {
  for (let step = 0; step < index; step += 1) click("Next");
}

it("explains the full toolbar without invoking tools or changing clipboard and selection", () => {
  const current = fixture();
  current.source.focus();
  expect(note()).toBeNull();
  current.tour.open(current.source);
  const initialNote = note();
  expect(initialNote?.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.disabled).toBe(true);
  expectStep("undo", 0, NORMAL_ACTIONS.length);
  click("Next");
  expectStep("select", 1, NORMAL_ACTIONS.length);
  click("Back");
  expectStep("undo", 0, NORMAL_ACTIONS.length);
  for (const [index, action] of NORMAL_ACTIONS.entries()) {
    expectStep(action, index, NORMAL_ACTIONS.length);
    expect(note()).toBe(initialNote);
    const preview = ["paste", "copy", "cut", "delete"].includes(action);
    expect(current.tour.contextPreview).toBe(preview);
    const target = current.root.querySelector<HTMLButtonElement>(
      `[data-inkbook-action="${action}"]`,
    );
    expect(target).not.toBeNull();
    if (preview) {
      expect(target?.disabled).toBe(true);
      const pointer = new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerType: "mouse",
      });
      target?.dispatchEvent(pointer);
      expect(pointer.defaultPrevented).toBe(true);
      target?.click();
      expect(note()).toBe(initialNote);
    }
    if (index < NORMAL_ACTIONS.length - 1) click("Next");
  }
  expect(description()).toContain("Plugin settings: Open More options, then Settings");
  click("Done");
  expect(note()).toBeNull();
  expect(document.activeElement).toBe(current.source);
  expect(current.tour.contextPreview).toBe(false);
  expect(current.root.querySelector('[data-inkbook-tour-preview="true"]')).toBeNull();
  expect(current.toolbarAction).not.toHaveBeenCalled();
  expect(current.paper.style.minBlockSize).toBe("80px");
});

it("includes finger drawing only when available and resets each explicit reopening", () => {
  const current = fixture(360, "80px", true);
  current.tour.open(current.source);
  const total = NORMAL_ACTIONS.length + 1;
  expectStep("finger-drawing", 0, total);
  expect(current.tour.contextPreview).toBe(false);
  goTo(NORMAL_ACTIONS.length - 1);
  expectStep("delete", NORMAL_ACTIONS.length - 1, total);
  click("Next");
  expectStep("overflow", NORMAL_ACTIONS.length, total);
  expect(current.tour.contextPreview).toBe(false);
  click("Done");
  current.tour.open(current.source);
  expectStep("finger-drawing", 0, total);
  expect(current.tour.contextPreview).toBe(false);
  click("Skip tour");
  expect(note()).toBeNull();
  expect(current.toolbarAction).not.toHaveBeenCalled();
});

it("waits for contextual controls to mount and resumes positioning without invoking them", async () => {
  const current = fixture(1200, "80px", false, true);
  current.tour.open(current.source);
  goTo(11);
  const layer = note()?.parentElement;
  expect(current.tour.contextPreview).toBe(true);
  expect(current.root.querySelector('[data-inkbook-action="paste"]')).toBeNull();
  const navigation = note()?.querySelector('[aria-label="Tour navigation"]');
  current.syncPreview(true);
  await vi.waitFor(() => expect(current.frames.size).toBe(1));
  current.flush();
  expect(layer?.querySelector(".inkbook-onboarding-arrow path")?.getAttribute("d")).toContain(
    " C ",
  );
  expectStep("paste", 11, NORMAL_ACTIONS.length);
  expect(note()?.querySelector('[aria-label="Tour navigation"]')).toBe(navigation);
  click("Back");
  expectStep("overflow", 10, NORMAL_ACTIONS.length);
  expect(current.tour.contextPreview).toBe(false);
  expect(current.root.querySelector('[data-inkbook-tour-preview="true"]')).toBeNull();
  expect(current.toolbarAction).not.toHaveBeenCalled();
});

it.each(["skip", "escape", "dispose"] as const)("releases contextual previews on %s", (exit) => {
  const current = fixture();
  current.tour.open(current.source);
  goTo(11);
  expect(current.tour.contextPreview).toBe(true);
  if (exit === "skip") click("Skip tour");
  else if (exit === "escape")
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
  else current.tour.dispose();
  expect(note()).toBeNull();
  expect(current.tour.contextPreview).toBe(false);
  expect(current.root.querySelector('[data-inkbook-tour-preview="true"]')).toBeNull();
  expect(current.onStateChanged).toHaveBeenCalledTimes(2);
  expect(current.toolbarAction).not.toHaveBeenCalled();
});

it("hands an outside Style click to the real panel without stealing its focus", () => {
  const current = fixture(360);
  const style = current.root.querySelector<HTMLButtonElement>('[data-inkbook-action="style"]')!;
  const scrollport = current.root.createDiv({ cls: "inkbook-toolbar-composition-scrollable" });
  scrollport.append(current.source, style);
  scrollport.getBoundingClientRect = () => new DOMRect(0, 80, 150, 50);
  current.source.getBoundingClientRect = () => new DOMRect(220 - scrollport.scrollLeft, 80, 44, 44);
  current.tour.open(current.source);
  goTo(8);
  const control = createHtmlElement("button");
  control.textContent = "Ink color";
  const fragment = window.createFragment();
  fragment.append(control);
  let panel: AdaptivePanelSession | undefined;
  style.addEventListener("click", () => {
    panel = new AdaptivePanelSession({
      anchor: style,
      canvasInputSurface: current.canvas,
      workScheduler: current.scheduler,
      createContent: () => fragment,
      initialFocus: control,
      restoreFocus: false,
      kind: "style",
      label: "Style",
      durationMs: 0,
      entryDurationMs: 0,
      ownerDocument: document,
      ownerWindow: window,
      renderIcon: () => undefined,
      onClosed: () => undefined,
    });
  });
  try {
    style.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    expect(document.querySelector(".inkbook-onboarding-tour")).toBeNull();
    expect(scrollport.scrollLeft).toBe(0);
    style.click();
    current.flush();
    expect(document.activeElement).toBe(control);
    current.tour.close();
    expect(document.activeElement).toBe(control);
    expect(current.toolbarAction).toHaveBeenCalledOnce();
  } finally {
    panel?.close("immediate");
  }
});

it.each(["escape", "close", "dispose"] as const)(
  "releases queued positioning, listeners and temporary paper space on %s",
  (exit) => {
    const current = fixture(360);
    current.tour.open(current.source);
    current.root.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(current.frames.size).toBe(1);
    const queued = [...current.frames.values()];
    if (exit === "escape") {
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    } else if (exit === "close") click("Skip tour");
    else current.tour.dispose();
    expect(current.frames.size).toBe(0);
    queued.forEach((callback) => callback(0));
    expect(note()).toBeNull();
    expect(document.querySelector(".inkbook-onboarding-arrow")).toBeNull();
    expect(current.paper.style.minBlockSize).toBe("80px");
    current.root.dispatchEvent(new Event("scroll", { bubbles: true }));
    window.dispatchEvent(new Event("resize"));
    expect(current.frames.size).toBe(0);
    if (exit !== "dispose") expect(document.activeElement).toBe(current.source);
    else {
      current.tour.open(current.source);
      expect(note()).toBeNull();
    }
  },
);

it("reveals the return control in its horizontal toolbar without scrolling the note", () => {
  const current = fixture(360);
  const scrollport = current.root.createDiv({ cls: "inkbook-toolbar-composition-scrollable" });
  scrollport.append(current.source);
  scrollport.getBoundingClientRect = () => new DOMRect(0, 80, 150, 50);
  current.source.getBoundingClientRect = () => new DOMRect(220 - scrollport.scrollLeft, 80, 44, 44);
  const originalScroll = window.scrollY;
  current.tour.open(current.source);
  current.tour.close();
  const control = current.source.getBoundingClientRect();
  const viewport = scrollport.getBoundingClientRect();
  expect(document.activeElement).toBe(current.source);
  expect(control.left).toBeGreaterThanOrEqual(viewport.left);
  expect(control.right).toBeLessThanOrEqual(viewport.right);
  expect(window.scrollY).toBe(originalScroll);
});

it("reserves presentation space for the invitation and restores original inline sizing on disposal", () => {
  const first = fixture();
  const current = fixture(360);
  current.tour.showInvitation(true);
  expect(current.paper.style.minBlockSize).toBe("220px");
  current.tour.open(current.source);
  expect(current.paper.style.minBlockSize).toBe("360px");
  expect(first.paper.style.minBlockSize).toBe("80px");
  Object.defineProperty(note()?.querySelector(".inkbook-onboarding-note"), "offsetHeight", {
    configurable: true,
    value: 248,
  });
  window.dispatchEvent(new Event("resize"));
  current.flush();
  expect(current.paper.style.minBlockSize).toBe("392px");
  const otherControl = first.source;
  otherControl.focus();
  current.tour.close();
  expect(document.activeElement).toBe(otherControl);
  expect(current.paper.style.minBlockSize).toBe("220px");
  current.tour.showInvitation(false);
  expect(current.paper.style.minBlockSize).toBe("80px");
  current.tour.showInvitation(true);
  current.tour.dispose();
  expect(current.paper.style.minBlockSize).toBe("80px");
});

it("keeps arrow and text strokes sequential and cancels retired steps before showing the next one", () => {
  vi.useFakeTimers();
  const animate = vi.spyOn(elementMotion, "animateOwnedElement");
  const current = fixture();
  current.root.dataset.inkbookMotion = "full";
  current.tour.open(current.source);
  const strokes = animate.mock.calls.filter(([element]) => element.tagName === "path");
  expect(strokes.length).toBeGreaterThan(2);
  for (const [index, [element, keyframes, options]] of strokes.entries()) {
    expect(element.isConnected).toBe(true);
    expect(keyframes).toEqual({ strokeDashoffset: ["1", "0"], opacity: [0, 1] });
    const previous = strokes[index - 1]?.[2];
    if (previous !== undefined) {
      expect(options.delay).toBeGreaterThanOrEqual(
        (previous.delay ?? 0) + previous.duration - 0.000001,
      );
    }
  }
  const retired = animate.mock.results.flatMap((result, index) =>
    animate.mock.calls[index]?.[0].tagName === "path" ? [vi.spyOn(result.value, "cancel")] : [],
  );
  click("Next");
  expect(description()).toContain("Select:");
  retired.forEach((cancel) => expect(cancel).toHaveBeenCalledOnce());
  const layer = note()?.parentElement;
  current.tour.dispose();
  expect(layer?.isConnected).toBe(false);
  expect(current.paper.style.minBlockSize).toBe("80px");
});

it("keeps navigation mounted across steps and retires input before fading and releasing paper space", () => {
  vi.useFakeTimers();
  const animate = vi.spyOn(elementMotion, "animateOwnedElement");
  const current = fixture(1200, "80px", false, false, 236);
  current.root.dataset.inkbookMotion = "full";
  current.tour.open(current.source);
  vi.advanceTimersByTime(220);
  const dialog = note();
  const layer = dialog?.parentElement;
  const navigation = dialog?.querySelector('[aria-label="Tour navigation"]');
  const next = dialog?.querySelector('[aria-label="Next"]');
  click("Next");
  expect(note()?.querySelector('[aria-label="Tour navigation"]')).toBe(navigation);
  expect(note()?.querySelector('[aria-label="Next"]')).toBe(next);
  click("Skip tour");
  expect(layer?.inert).toBe(true);
  expect(layer?.getAttribute("aria-hidden")).toBe("true");
  expect(layer?.isConnected).toBe(true);
  expect(document.activeElement).toBe(current.source);
  expect(current.paper.style.minBlockSize).toBe("360px");
  vi.advanceTimersByTime(220);
  expect(layer?.isConnected).toBe(false);
  const shrink = [...animate.mock.calls].reverse().find(([element]) => element === current.paper);
  // A zero target would finish the visible shrink before the minimum-size animation ends.
  expect(shrink?.[1].minBlockSize).toEqual(["236px", "236px"]);
  vi.advanceTimersByTime(220);
  expect(current.paper.style.minBlockSize).toBe("80px");
  expect(current.frames.size).toBe(0);
});

it("cancels a retiring tour when reopened and cannot shrink the replacement from a stale exit", () => {
  vi.useFakeTimers();
  const current = fixture();
  current.root.dataset.inkbookMotion = "full";
  current.tour.open(current.source);
  vi.advanceTimersByTime(220);
  const previous = note()?.parentElement;
  click("Skip tour");
  current.tour.open(current.source);
  expect(previous?.isConnected).toBe(false);
  vi.advanceTimersByTime(1000);
  expectStep("undo", 0, NORMAL_ACTIONS.length);
  expect(current.paper.style.minBlockSize).toBe("360px");
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
});

it("finishes a pending guide exit when reduced motion is enabled", async () => {
  vi.useFakeTimers();
  const current = fixture();
  current.root.dataset.inkbookMotion = "full";
  current.tour.open(current.source);
  vi.advanceTimersByTime(220);
  click("Skip tour");
  expect(note()).not.toBeNull();
  current.root.dataset.inkbookMotion = "reduced";
  await Promise.resolve();
  expect(note()).toBeNull();
  expect(current.paper.style.minBlockSize).toBe("80px");
  vi.advanceTimersByTime(1000);
  expect(current.paper.style.minBlockSize).toBe("80px");
});
