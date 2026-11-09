import { Localization } from "../../../../src/domain/localization";
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from "vitest";

import { renderImportExamples } from "../../../../src/obsidian/settings/import/import-examples";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { assertAccessibleSemantics } from "../../../fixtures/accessibility";

const disposers: Array<() => void> = [];

beforeEach(installObsidianDomHelpers);
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

function gallery(motion: "full" | "reduced" = "reduced") {
  const container = document.body.createDiv();
  container.dataset.inkbookMotion = motion;
  const subscriptions = new Set<() => void>();
  renderImportExamples(container, {
    localization: new Localization(),
    mutate: (update) => update(),
    readMotion: () => (container.dataset.inkbookMotion === "full" ? "full" : "reduced"),
    observeMotion: (listener) => {
      subscriptions.add(listener);
      return () => subscriptions.delete(listener);
    },
    own: (dispose) => disposers.push(dispose),
  });
  return {
    container,
    subscriptions,
    previous: container.querySelector<HTMLButtonElement>('[aria-label="Previous example"]')!,
    next: container.querySelector<HTMLButtonElement>('[aria-label="Next example"]')!,
    status: container.querySelector<HTMLElement>('[aria-live="polite"]')!,
    images: [...container.querySelectorAll("img")],
  };
}

it("shows an accessible offline comparison with honest conversion warnings before import", async () => {
  const { container, images, status } = gallery();
  expect(status.textContent).toContain("Curves and pressure");
  expect(status.textContent).toContain("Example 1 of 3");
  expect(status.getAttribute("aria-atomic")).toBe("true");
  expect(
    [...container.querySelectorAll("figcaption")].map((caption) => caption.textContent),
  ).toEqual(["Before · Obsidian Ink", "After · Inkbook"]);
  expect(container.textContent).toContain("Stroke thickness, curves and backgrounds can change.");
  expect(container.textContent).toContain("Review the copies before removing originals.");
  expect(container.textContent).toContain(
    "broad wedges at these curved corners are not fully preserved",
  );
  expect(images).toHaveLength(2);
  expect(images[0]!.alt).toContain("handwritten boxes and arrows");
  expect(images[1]!.alt).toContain("less pronounced wedges");
  for (const image of images) expect(image.src.startsWith("data:image/png;base64,")).toBe(true);
  expect(container.querySelectorAll("a, iframe")).toHaveLength(0);
  await assertAccessibleSemantics(container, ["button-name", "image-alt"]);
});

it("browses all examples in both directions with bounded image ownership and usable focus", () => {
  const { container, previous, next, status, images, subscriptions } = gallery("full");
  container.dataset.inkbookMotion = "reduced";
  for (const notify of subscriptions) notify();
  const initialSources = images.map((image) => image.src);
  expect(previous.disabled).toBe(true);
  previous.click();
  expect(status.textContent).toContain("Example 1 of 3");
  next.click();
  expect(status.textContent).toContain("Print handwriting");
  expect(status.textContent).toContain("Example 2 of 3");
  expect(document.activeElement).toBe(next);
  expect(images[0]!.alt).toContain("written in print");
  expect(images[1]!.alt).toContain("same print alphabet");
  next.click();
  expect(status.textContent).toContain("Cursive handwriting");
  expect(status.textContent).toContain("Example 3 of 3");
  expect(images[0]!.alt).toContain("cursive handwriting");
  expect(images[1]!.alt).toContain("same cursive alphabet");
  expect(next.disabled).toBe(true);
  expect(document.activeElement).toBe(previous);
  next.click();
  expect(status.textContent).toContain("Example 3 of 3");
  previous.click();
  expect(status.textContent).toContain("Example 2 of 3");
  previous.click();
  expect(status.textContent).toContain("Example 1 of 3");
  expect(previous.disabled).toBe(true);
  expect(next.disabled).toBe(false);
  expect(document.activeElement).toBe(next);
  expect([...container.querySelectorAll("img")]).toEqual(images);
  expect(images.every((image, index) => image.src === initialSources[index])).toBe(true);
});

it("releases preference subscriptions and prevents detached controls from changing images", () => {
  const { container, subscriptions, next, images, status } = gallery();
  expect(subscriptions.size).toBeGreaterThan(0);
  const initialSources = images.map((image) => image.src);
  for (const dispose of disposers.splice(0)) dispose();
  container.remove();
  expect(subscriptions.size).toBe(0);
  next.click();
  expect(status.textContent).toContain("Example 1 of 3");
  expect(images.every((image, index) => image.src === initialSources[index])).toBe(true);
});
