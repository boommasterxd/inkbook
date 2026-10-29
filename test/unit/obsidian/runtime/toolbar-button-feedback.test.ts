// @vitest-environment happy-dom

import { Window as HappyWindow } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";

import { toolbarButtonFeedback } from "../../../../src/rendering/motion/toolbar-button-feedback";
import { createChromePalette } from "../../../../src/rendering/ui/chrome-palette";
import { animateOwnedElement } from "../../../../src/obsidian/runtime/element-motion";
import { mountToolbarButtonFeedback } from "../../../../src/obsidian/runtime/toolbar-button-feedback";

const colors = {
  accent: "rgba(100, 0, 100, 1)",
  danger: "rgba(200, 0, 0, 1)",
  faint: "rgba(50, 50, 50, 1)",
  muted: "rgba(80, 80, 80, 1)",
  activeBackground: "rgba(100, 0, 100, 0.2)",
  activeBorder: "rgba(100, 0, 100, 0.5)",
  dangerHover: "rgba(200, 0, 0, 0.2)",
  hover: "rgba(80, 80, 80, 0.2)",
};

vi.mock("../../../../src/rendering/ui/chrome-palette", () => ({
  createChromePalette: vi.fn(() => ({ read: vi.fn(() => colors), dispose: vi.fn() })),
}));
vi.mock("../../../../src/obsidian/runtime/element-motion", () => ({
  animateOwnedElement: vi.fn(() => ({
    stop: vi.fn(),
    cancel: vi.fn(),
    finished: Promise.resolve(),
  })),
}));

const releases: Array<() => void> = [];

afterEach(() => {
  for (const release of releases.splice(0)) release();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

function fixture(owner: Window = window) {
  const root = owner.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  root.dataset.inkbookMotion = "full";
  const navigation = owner.document.createElementNS("http://www.w3.org/1999/xhtml", "nav");
  root.append(navigation);
  owner.document.body.append(root);
  const buttons = [true, false, false].map((disabled) => {
    const button = owner.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button",
    ) as HTMLButtonElement;
    button.type = "button";
    button.disabled = disabled;
    const surface = owner.document.createElementNS("http://www.w3.org/1999/xhtml", "span");
    surface.className = "inkbook-toolbar-button-surface";
    button.append(surface);
    navigation.append(button);
    return { button, surface };
  });
  const feedback = mountToolbarButtonFeedback(navigation, root);
  releases.push(feedback.dispose, () => root.remove());
  return { root, feedback, back: buttons[0]!, ...buttons[1]! };
}

function pointer(target: EventTarget, type: string, pointerType = "mouse", pointerId = 7) {
  target.dispatchEvent(
    new PointerEvent(type, { button: 0, isPrimary: true, pointerType, pointerId, bubbles: true }),
  );
}

function expectedTargets(gesture: "rest" | "hover" | "press") {
  const policy = toolbarButtonFeedback(colors);
  const state = { ...policy.rest, ...policy[gesture] };
  return {
    backgroundColor: state["--inkbook-toolbar-background"],
    borderColor: state["--inkbook-toolbar-border"],
    scale: state.scale,
  };
}

function lastTargets() {
  return vi.mocked(animateOwnedElement).mock.calls.slice(-1)[0]?.[1];
}

it("shares the toolbar press policy, releases outside and keeps the native hit area intact", () => {
  const { button, surface } = fixture();
  pointer(button, "pointerenter", "touch");
  expect(lastTargets()).toEqual(expectedTargets("rest"));
  pointer(button, "pointerdown", "touch");
  expect(lastTargets()).toEqual(expectedTargets("press"));
  expect(vi.mocked(animateOwnedElement).mock.calls.slice(-1)[0]).toEqual([
    surface,
    lastTargets(),
    { duration: 0.12, ease: [0.2, 0, 0, 1] },
  ]);
  pointer(window, "pointerup", "touch");
  expect(lastTargets()).toEqual(expectedTargets("rest"));
  expect(button.style.cssText).toBe("");

  pointer(button, "pointerenter", "pen");
  pointer(button, "pointerdown", "pen");
  pointer(window, "pointerup", "pen");
  expect(lastTargets()).toEqual(expectedTargets("hover"));
  pointer(button, "pointerleave", "pen");
  expect(lastTargets()).toEqual(expectedTargets("rest"));
});

it("owns pop-out release, cancellation, lost capture and blur in the button's window", () => {
  const owner = new HappyWindow() as unknown as Window;
  const { button } = fixture(owner);
  pointer(button, "pointerdown", "touch");
  pointer(window, "pointerup", "touch");
  expect(lastTargets()?.scale).toBe(0.92);
  pointer(owner, "pointerup", "touch", 8);
  expect(lastTargets()?.scale).toBe(0.92);
  pointer(owner, "pointerup", "touch");
  expect(lastTargets()?.scale).toBe(1);
  for (const [target, event] of [
    [owner, "pointercancel"],
    [button, "lostpointercapture"],
    [button, "blur"],
    [owner, "blur"],
    [owner, "pagehide"],
  ] as const) {
    pointer(button, "pointerdown", "touch");
    pointer(target, event, "touch");
    expect(lastTargets()?.scale).toBe(1);
  }
});

it.each([" ", "Enter"])("preserves native %j keyboard semantics and clears held presses", (key) => {
  const { button, feedback } = fixture();
  button.focus();
  const down = new KeyboardEvent("keydown", { key, cancelable: true });
  button.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(false);
  expect(lastTargets()?.scale).toBe(0.92);
  feedback.refresh();
  expect(lastTargets()?.scale).toBe(0.92);
  button.dispatchEvent(new KeyboardEvent("keyup", { key }));
  expect(lastTargets()?.scale).toBe(1);
  button.dispatchEvent(new KeyboardEvent("keydown", { key }));
  button.blur();
  expect(lastTargets()?.scale).toBe(1);
});

it("clears disabled feedback immediately and rebinds once the control becomes available", () => {
  const { button, surface, back, feedback } = fixture();
  const calls = vi.mocked(animateOwnedElement).mock.calls.length;
  pointer(back.button, "pointerdown");
  back.button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  expect(animateOwnedElement).toHaveBeenCalledTimes(calls);
  pointer(button, "pointerdown");
  button.disabled = true;
  feedback.refresh();
  expect(surface.style.scale).toBe("1");
  expect(surface.style.backgroundColor).toBe(
    toolbarButtonFeedback(colors).rest["--inkbook-toolbar-background"],
  );
  button.disabled = false;
  feedback.refresh();
  pointer(button, "pointerdown", "touch");
  expect(lastTargets()?.scale).toBe(0.92);
});

it("shares one palette, avoids theme reads during gestures and releases animation resources", async () => {
  const { button, surface, feedback, root } = fixture();
  expect(createChromePalette).toHaveBeenCalledOnce();
  const palette = vi.mocked(createChromePalette).mock.results[0]!.value as ReturnType<
    typeof createChromePalette
  >;
  expect(palette.read).toHaveBeenCalledOnce();
  const geometry = vi.spyOn(surface, "getBoundingClientRect");
  pointer(button, "pointerenter");
  pointer(button, "pointerdown");
  pointer(button, "pointerleave");
  pointer(window, "pointerup");
  feedback.refresh();
  expect(palette.read).toHaveBeenCalledOnce();
  expect(geometry).not.toHaveBeenCalled();
  root.dataset.inkbookScheme = "dark";
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  expect(palette.read).toHaveBeenCalledTimes(2);
  const animations = vi
    .mocked(animateOwnedElement)
    .mock.results.map((result) => result.value as ReturnType<typeof animateOwnedElement>);
  feedback.dispose();
  expect(palette.dispose).toHaveBeenCalledOnce();
  expect(
    animations.every(
      (animation) =>
        vi.mocked(animation, true).stop.mock.calls.length +
          vi.mocked(animation, true).cancel.mock.calls.length >
        0,
    ),
  ).toBe(true);
  const calls = vi.mocked(animateOwnedElement).mock.calls.length;
  pointer(button, "pointerdown");
  root.dataset.inkbookScheme = "light";
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  expect(animateOwnedElement).toHaveBeenCalledTimes(calls);
  expect(palette.read).toHaveBeenCalledTimes(2);
  expect(surface.style.cssText).toBe("");
});

it("settles an interrupted animation immediately when reduced motion is enabled", async () => {
  const { button, surface, root } = fixture();
  pointer(button, "pointerdown", "touch");
  const active = vi.mocked(animateOwnedElement).mock.results.slice(-1)[0]!.value as ReturnType<
    typeof animateOwnedElement
  >;
  root.dataset.inkbookMotion = "reduced";
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  expect(active.stop).toHaveBeenCalledOnce();
  expect(surface.style.scale).toBe("0.92");
  pointer(window, "pointerup", "touch");
  expect(surface.style.scale).toBe("1");
  expect(surface.style.backgroundColor).toBe(
    toolbarButtonFeedback(colors).rest["--inkbook-toolbar-background"],
  );
});
