// @vitest-environment happy-dom

import { Window as HappyWindow } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { createSvgElement } from "../../../adapters/obsidian/dom";

import {
  animateOwnedElement,
  animateOwnedElements,
} from "../../../../src/obsidian/runtime/element-motion";

it("uses seconds for SVG drawing delays and cancels the owned pen animation", () => {
  const path = createSvgElement("path");
  const controls = animateOwnedElement(
    path,
    { strokeDashoffset: ["1", "0"] },
    { duration: 0.5, delay: 0.78 },
  );
  const animation = path.getAnimations()[0]!;
  expect(animation.effect?.getTiming()).toMatchObject({ duration: 500, delay: 780 });
  controls.cancel();
  expect(path.getAnimations()).toHaveLength(0);
});

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

  it("retains a shared exit until both surfaces finish and cancels all remaining targets", async () => {
    const container = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    const backdrop = container.appendChild(
      document.createElementNS("http://www.w3.org/1999/xhtml", "div"),
    );
    const surface = container.appendChild(
      document.createElementNS("http://www.w3.org/1999/xhtml", "div"),
    );
    document.body.append(container);
    const remove = vi.fn(() => container.remove());
    const targets = [
      { element: surface, keyframes: { scale: [1, 0.96], opacity: [1, 0] } },
      { element: backdrop, keyframes: { opacity: [1, 0] } },
    ];
    const controls = animateOwnedElements(targets, { duration: 0.12, onComplete: remove });
    const surfaceAnimations = surface.getAnimations();
    surfaceAnimations[0]!.finish();
    await Promise.resolve();
    expect(container.isConnected).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    backdrop.getAnimations()[0]!.finish();
    await Promise.resolve();
    expect(container.isConnected).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    surfaceAnimations[1]!.finish();
    await controls.finished;
    expect(remove).toHaveBeenCalledOnce();
    expect(container.isConnected).toBe(false);

    remove.mockClear();
    const interrupted = animateOwnedElements(targets, { duration: 0.12, onComplete: remove });
    interrupted.stop();
    await Promise.resolve();
    expect(remove).not.toHaveBeenCalled();
    expect(surface.getAnimations()).toHaveLength(0);
    expect(backdrop.getAnimations()).toHaveLength(0);
  });
});
