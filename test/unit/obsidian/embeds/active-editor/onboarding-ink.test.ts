// @vitest-environment happy-dom
import "../../../../fixtures/obsidian/menu-motion";

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OnboardingInk } from "../../../../../src/obsidian/embeds/active-editor/onboarding-ink";
import * as elementMotion from "../../../../../src/obsidian/runtime/element-motion";
import { createHtmlElement, installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";

beforeEach(installObsidianDomHelpers);

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const inks: OnboardingInk[] = [];
afterEach(() => {
  inks.splice(0).forEach((ink) => ink.dispose());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function drawing() {
  const ink = new OnboardingInk();
  inks.push(ink);
  const parent = createHtmlElement("div");
  const arrow = document.createElementNS(SVG_NAMESPACE, "svg");
  parent.append(arrow);
  ink.path(arrow, 180, 500).setAttribute("d", "M0 40 C0 20 20 20 20 0");
  ink.path(arrow, 680, 100).setAttribute("d", "M15 9 L20 0 L25 9");
  ink.lettering(parent, "make it yours", true, 780);
  ink.lettering(parent, "color and width", false, 1580);
  return { ink, parent };
}

it("draws the arrow before lettering and sequences actual cubic strokes without a frame loop", () => {
  vi.useFakeTimers();
  const animate = vi.spyOn(elementMotion, "animateOwnedElement");
  const { ink, parent } = drawing();
  const paths = [...parent.querySelectorAll("path")];
  paths.forEach((path) => expect(path.getAttribute("opacity")).toBe("0"));
  expect(animate).not.toHaveBeenCalled();
  ink.play(false);
  expect(animate).toHaveBeenCalledTimes(paths.length);
  expect(animate.mock.calls[0]?.[2]).toMatchObject({ delay: 0.18, duration: 0.5 });
  expect(animate.mock.calls[1]?.[2]).toMatchObject({ delay: 0.68, duration: 0.1 });
  expect(animate.mock.calls[2]?.[2].delay).toBe(0.78);
  for (const [index, [element, keyframes, options]] of animate.mock.calls.entries()) {
    expect(element).toBe(paths[index]);
    expect(keyframes).toEqual({ strokeDashoffset: ["1", "0"], opacity: [0, 1] });
    expect(options.duration).toBeGreaterThan(0);
    const previous = animate.mock.calls[index - 1]?.[2];
    if (previous !== undefined) {
      expect(options.delay).toBeGreaterThanOrEqual(
        (previous.delay ?? 0) + previous.duration - 0.000001,
      );
    }
  }
  const cancellations = animate.mock.results.map((result) => vi.spyOn(result.value, "cancel"));
  ink.dispose();
  cancellations.forEach((cancel) => expect(cancel).toHaveBeenCalledOnce());
  ink.dispose();
  cancellations.forEach((cancel) => expect(cancel).toHaveBeenCalledOnce());
});

it("completes all strokes immediately under reduced motion without scheduling drawing animations", () => {
  const animate = vi.spyOn(elementMotion, "animateOwnedElement");
  const { ink, parent } = drawing();
  ink.play(true);
  expect(animate).not.toHaveBeenCalled();
  for (const path of parent.querySelectorAll("path")) {
    expect(path.getAttribute("stroke-dashoffset")).toBe("0");
    expect(path.getAttribute("opacity")).toBe("1");
  }
  for (const svg of parent.querySelectorAll("svg:not(:first-child)")) {
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
  }
});

it("cancels pending drawing on a motion preference change and makes the complete message visible", () => {
  vi.useFakeTimers();
  const animate = vi.spyOn(elementMotion, "animateOwnedElement");
  const { ink, parent } = drawing();
  ink.play(false);
  const cancellations = animate.mock.results.map((result) => vi.spyOn(result.value, "cancel"));
  ink.finish();
  cancellations.forEach((cancel) => expect(cancel).toHaveBeenCalledOnce());
  for (const path of parent.querySelectorAll("path"))
    expect(path.getAttribute("stroke-dashoffset")).toBe("0");
});
