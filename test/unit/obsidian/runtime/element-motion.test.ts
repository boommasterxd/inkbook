// @vitest-environment happy-dom

import { Window as HappyWindow } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { animateOwnedElement } from "../../../../src/obsidian/runtime/element-motion";

describe("owned native Motion lifecycle", () => {
  it("completes a foreign-window group only after all properties finish", async () => {
    const owner = new HappyWindow();
    const element = owner.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as unknown as HTMLElement;
    const complete = vi.fn();
    const controls = animateOwnedElement(
      element,
      { scale: [0.96, 1], opacity: [0, 1] },
      { duration: 0.12, onComplete: complete },
    );
    const animations = element.getAnimations();
    expect(animations).toHaveLength(2);
    animations[0]!.finish();
    await Promise.resolve();
    expect(complete).not.toHaveBeenCalled();
    animations[1]!.finish();
    await controls.finished;
    expect(complete).toHaveBeenCalledOnce();
    expect(element.getAnimations()).toHaveLength(0);
    await owner.happyDOM.abort();
  });

  it("stops interrupted properties without completing the exit lifecycle", async () => {
    const element = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    const complete = vi.fn();
    const controls = animateOwnedElement(
      element,
      { opacity: [1, 0] },
      { duration: 0.12, onComplete: complete },
    );
    controls.stop();
    await Promise.resolve();
    expect(complete).not.toHaveBeenCalled();
    expect(element.getAnimations()).toHaveLength(0);
  });
});
