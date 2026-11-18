// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { Localization } from "../../../../src/domain/localization";
import { renderImportExamples } from "../../../../src/obsidian/settings/import/import-examples";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { assertAccessibleSemantics } from "../../../fixtures/accessibility";

const disposers: Array<() => void> = [];

beforeEach(installObsidianDomHelpers);
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

async function gallery(motion: "full" | "reduced" = "reduced") {
  const container = document.body.createDiv();
  container.dataset.inkbookMotion = motion;
  const subscriptions = new Set<() => void>();
  renderImportExamples(
    container,
    {
      localization: new Localization(),
      mutate: (update) => update(),
      readMotion: () => (container.dataset.inkbookMotion === "full" ? "full" : "reduced"),
      observeMotion: (listener) => {
        subscriptions.add(listener);
        return () => subscriptions.delete(listener);
      },
      own: (dispose) => disposers.push(dispose),
    },
    "diagram",
  );
  await vi.waitFor(() =>
    expect(container.querySelector("img")?.alt).toContain("handwritten boxes"),
  );
  return {
    container,
    subscriptions,
    choices: [
      ...container.querySelectorAll<HTMLButtonElement>(".inkbook-import-example-choices button"),
    ],
    status: container.querySelector<HTMLElement>('[role="status"]')!,
    images: [...container.querySelectorAll("img")],
  };
}

it("shows an accessible offline comparison clearly distinguished from the user's files", async () => {
  const { container, choices, images, status } = await gallery();
  expect(choices.map((choice) => choice.textContent)).toEqual([
    "Curves and pressure",
    "Print handwriting",
    "Cursive handwriting",
    "Rounded corners",
    "Coordinate rounding",
  ]);
  expect(choices[0]?.getAttribute("aria-pressed")).toBe("true");
  expect(status.getAttribute("aria-atomic")).toBe("true");
  expect(
    [...container.querySelectorAll("figcaption")].map((caption) => caption.textContent),
  ).toEqual(["Before · Obsidian Ink", "After · Inkbook"]);
  expect(container.textContent).toContain("General examples. Your files may look different.");
  expect(status.textContent).toContain(
    "broad wedges at these curved corners are not fully preserved",
  );
  expect(images).toHaveLength(2);
  expect(images[0]!.alt).toContain("handwritten boxes and arrows");
  expect(images[1]!.alt).toContain("less pronounced wedges");
  for (const image of images) expect(image.src.startsWith("data:image/png;base64,")).toBe(true);
  expect(container.querySelectorAll("a, iframe")).toHaveLength(0);
  await assertAccessibleSemantics(container, ["button-name", "image-alt"]);
});

it("selects every named example directly while retaining only two image slots and keyboard focus", async () => {
  const { container, choices, status, images, subscriptions } = await gallery("full");
  container.dataset.inkbookMotion = "reduced";
  for (const notify of subscriptions) notify();
  const initialSources = images.map((image) => image.src);
  const cases = [
    [2, "cursive handwriting", "same cursive alphabet"],
    [1, "written in print", "same print alphabet"],
    [3, "rounded corners", "square corners"],
    [4, "12.3456", "12.346"],
  ] as const;
  for (const [index, before, after] of cases) {
    const choice = choices[index]!;
    choice.focus();
    choice.click();
    expect(document.activeElement).toBe(choice);
    expect(choices.filter((button) => button.getAttribute("aria-pressed") === "true")).toEqual([
      choice,
    ]);
    expect(images[0]!.alt).toContain(before);
    expect(images[1]!.alt).toContain(after);
    expect([...container.querySelectorAll("img")]).toEqual(images);
  }
  expect(status.textContent).toContain("Magnified diagram");
  choices[0]!.click();
  expect(images.map((image) => image.src)).toEqual(initialSources);
});

it("releases preference subscriptions and prevents detached controls from changing images", async () => {
  const { container, subscriptions, choices, images } = await gallery();
  expect(subscriptions.size).toBeGreaterThan(0);
  const initialSources = images.map((image) => image.src);
  for (const dispose of disposers.splice(0)) dispose();
  container.remove();
  expect(subscriptions.size).toBe(0);
  choices[3]!.click();
  expect(choices[3]!.getAttribute("aria-pressed")).toBe("false");
  expect(images.map((image) => image.src)).toEqual(initialSources);
});
