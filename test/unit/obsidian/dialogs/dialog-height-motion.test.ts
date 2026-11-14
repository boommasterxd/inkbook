// @vitest-environment happy-dom

import { Window as HappyWindow } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DialogHeightMotion } from "../../../../src/obsidian/dialogs/dialog-height-motion";
import type { MotionPreference } from "../../../../src/rendering/motion/transitions";

const cleanups: Array<() => void> = [];

function setup(popout = false, supportsIntrinsicSize = true) {
  const owner = popout ? new HappyWindow() : undefined;
  const ownerDocument = (owner?.document ?? document) as unknown as Document;
  const surface = ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
  const ownerWindow = surface.ownerDocument.defaultView!;
  ownerDocument.body.append(surface);
  const css = ownerWindow.CSS;
  vi.spyOn(ownerWindow, "CSS", "get").mockReturnValue(css);
  vi.spyOn(css, "supports").mockReturnValue(supportsIntrinsicSize);
  let height = "240px";
  const reads = vi.spyOn(ownerWindow, "getComputedStyle").mockImplementation(
    () =>
      ({
        get height() {
          return height;
        },
      }) as CSSStyleDeclaration,
  );
  let preference: MotionPreference = "full";
  let changed = (): void => undefined;
  const unsubscribe = vi.fn();
  const create = () =>
    new DialogHeightMotion(
      surface,
      () => preference,
      (listener) => {
        changed = listener;
        return unsubscribe;
      },
    );
  const motion = create();
  cleanups.push(() => {
    motion.dispose();
    surface.remove();
    owner?.close();
  });
  return {
    surface,
    motion,
    reads,
    unsubscribe,
    create,
    setHeight: (value: string) => {
      height = value;
    },
    setReduced: () => {
      preference = "reduced";
      changed();
    },
  };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

describe("dialog intrinsic height ownership", () => {
  it.each([false, true])(
    "captures before nested content changes and owns one height animation in pop-out %s",
    (popout) => {
      const view = setup(popout);
      view.motion.mutate(() => {
        expect(view.reads).toHaveBeenCalledOnce();
        view.surface.append("Import review");
        view.motion.mutate(() => view.surface.append(" with selected files"));
      });
      expect(view.surface.textContent).toBe("Import review with selected files");
      expect(view.reads).toHaveBeenCalledOnce();
      const animation = view.surface.getAnimations()[0]!;
      expect(view.surface.getAnimations()).toHaveLength(1);
      expect((animation.effect as KeyframeEffect).getKeyframes()).toMatchObject([
        { height: "240px" },
        { height: "auto" },
      ]);
      animation.finish();
      expect(view.surface.getAnimations()).toHaveLength(0);
      expect(view.surface.style.height).toBe("");
    },
  );

  it("reverses from the current visible height without retaining the previous animation", () => {
    const view = setup();
    view.motion.mutate(() => view.surface.append("Review"));
    const first = view.surface.getAnimations()[0]!;
    view.setHeight("310px");
    view.reads.mockClear();
    view.motion.mutate(() => {
      expect(view.reads).toHaveBeenCalledOnce();
      view.surface.replaceChildren("Library");
    });
    expect(first.playState).toBe("idle");
    const current = view.surface.getAnimations()[0]!;
    expect(view.surface.getAnimations()).toHaveLength(1);
    expect((current.effect as KeyframeEffect).getKeyframes()).toMatchObject([
      { height: "310px" },
      { height: "auto" },
    ]);
    current.finish();
    expect(view.surface.textContent).toBe("Library");
    expect(view.surface.style.height).toBe("");
  });

  it("freezes the visible shell through content teardown and restores its height on disposal", () => {
    const view = setup();
    view.motion.mutate(() => view.surface.append("Import review"));
    view.setHeight("280px");
    view.motion.freeze();
    expect(view.surface.getAnimations()).toHaveLength(0);
    expect(view.surface.style.height).toBe("280px");
    view.reads.mockClear();
    view.motion.mutate(() => view.surface.replaceChildren());
    view.motion.freeze();
    expect(view.surface.style.height).toBe("280px");
    expect(view.reads).not.toHaveBeenCalled();
    expect(view.surface.getAnimations()).toHaveLength(0);
    view.motion.dispose();
    view.motion.dispose();
    expect(view.surface.style.height).toBe("");
    expect(view.unsubscribe).toHaveBeenCalledOnce();
    const update = vi.fn();
    view.motion.mutate(update);
    expect(update).not.toHaveBeenCalled();
  });

  it("cancels active ownership and restores an existing inline height and priority", () => {
    const view = setup();
    view.motion.dispose();
    view.surface.style.setProperty("height", "70vh", "important");
    const motion = view.create();
    motion.mutate(() => view.surface.append("Library"));
    expect(view.surface.getAnimations()).toHaveLength(1);
    motion.dispose();
    expect(view.surface.getAnimations()).toHaveLength(0);
    expect(view.surface.style.getPropertyValue("height")).toBe("70vh");
    expect(view.surface.style.getPropertyPriority("height")).toBe("important");
  });
});

describe("dialog height immediate paths", () => {
  it("settles an interrupted transition immediately when reduced motion changes live", () => {
    const view = setup();
    view.motion.mutate(() => view.surface.append("Review"));
    view.setReduced();
    expect(view.surface.getAnimations()).toHaveLength(0);
    expect(view.surface.style.height).toBe("");
    view.reads.mockClear();
    view.motion.mutate(() => view.surface.replaceChildren("Library"));
    expect(view.surface.textContent).toBe("Library");
    expect(view.reads).not.toHaveBeenCalled();
    expect(view.surface.getAnimations()).toHaveLength(0);
  });

  it.each(["disconnected", "unsupported"])("updates content immediately when %s", (state) => {
    const view = setup(false, state !== "unsupported");
    if (state === "disconnected") view.surface.remove();
    view.motion.mutate(() => view.surface.append("Library"));
    expect(view.surface.textContent).toBe("Library");
    expect(view.reads).not.toHaveBeenCalled();
    expect(view.surface.getAnimations()).toHaveLength(0);
    expect(view.surface.style.height).toBe("");
  });
});
