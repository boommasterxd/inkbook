// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

import { AdaptivePanelLayout } from "../../../../../src/obsidian/menus/panels/adaptive-panel-layout";
import { createAdaptivePanelFixture } from "../../../../adapters/obsidian/adaptive-panel";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("lets Motion snapshot native content before and after its layout commit", async () => {
  installObsidianDomHelpers();
  const surface = createEl("section");
  const grabber = createDiv();
  const scroll = createDiv();
  const item = createEl("button");
  item.textContent = "Before";
  scroll.append(item);
  document.body.append(surface);
  const measurements: string[] = [];
  const layout = new AdaptivePanelLayout(surface, grabber, scroll);
  cleanups.push(() => layout.dispose());
  const outer = surface.firstElementChild?.firstElementChild;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this === outer) measurements.push(item.textContent ?? "");
    return new DOMRect(0, 0, 200, item.textContent === "Before" ? 100 : 180);
  });

  layout.mutate(() => {
    measurements.push("mutation");
    item.textContent = "After";
  }, 220);
  await vi.waitFor(() => expect(measurements).toContain("After"));

  expect(measurements.indexOf("Before")).toBeLessThan(measurements.indexOf("mutation"));
  expect(measurements.indexOf("mutation")).toBeLessThan(measurements.indexOf("After"));
  expect(item.isConnected).toBe(true);
  expect(scroll.closest(".inkbook-adaptive-panel-motion-surface")).toBe(outer);
  expect(grabber.closest(".inkbook-adaptive-panel-motion-surface")).toBe(outer);
  expect(scroll.style.blockSize).toBe("");
  layout.dispose();
  expect(surface.childElementCount).toBe(0);
});

it("includes a viewport-edge placement flip in the content layout commit", async () => {
  installObsidianDomHelpers();
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(199);
  const measurements: { text: string; top: number; height: number }[] = [];
  const control = createEl("button", { text: "Compact" });
  const height = () => (control.textContent === "Compact" ? 100 : 220);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(height);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const surface = this.closest<HTMLElement>(".inkbook-adaptive-panel");
    const top = Number.parseFloat(surface?.style.insetBlockStart ?? "0") || 0;
    if (this.classList.contains("inkbook-adaptive-panel-motion-surface")) {
      measurements.push({ text: control.textContent ?? "", top, height: height() });
    }
    return new DOMRect(0, top, 199, height());
  });
  const fixture = createAdaptivePanelFixture("background", {
    anchorRect: new DOMRect(300, 320, 44, 44),
    createContent: (lifecycle) => {
      const fragment = window.createFragment();
      fragment.append(control);
      control.addEventListener("click", () => {
        lifecycle.mutateLayout(() => {
          control.textContent = "Expanded";
        });
      });
      return fragment;
    },
  });
  cleanups.push(() => fixture.session.close("immediate"));
  const painted = document.querySelector<HTMLElement>(".inkbook-adaptive-panel-motion-surface");
  expect(painted?.getBoundingClientRect().top).toBe(368);
  const root = fixture.anchor.closest<HTMLElement>(".inkbook-root");
  if (root !== null) root.dataset.inkbookMotion = "full";
  control.focus();

  control.click();

  await vi.waitFor(() => expect(measurements.some(({ text }) => text === "Expanded")).toBe(true));
  expect(measurements).toContainEqual({ text: "Compact", top: 368, height: 100 });
  const expanded = measurements.filter(({ text }) => text === "Expanded");
  expect(
    expanded.every(({ top, height: measuredHeight }) => top === 96 && top + measuredHeight <= 500),
  ).toBe(true);
  expect(document.activeElement).toBe(control);
  fixture.session.close("immediate");
});

it("applies reduced geometry to both projections without replacing the focused control", async () => {
  installObsidianDomHelpers();
  const surface = createEl("section");
  const grabber = createDiv();
  const scroll = createDiv();
  const control = createEl("button", { text: "Compact" });
  scroll.append(control);
  document.body.append(surface);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, 200, control.textContent === "Compact" ? 100 : 220),
  );
  const layout = new AdaptivePanelLayout(surface, grabber, scroll);
  cleanups.push(() => layout.dispose());
  control.focus();
  layout.mutate(() => {
    control.textContent = "Expanded";
  }, 220);
  const painted = surface.querySelector<HTMLElement>(".inkbook-adaptive-panel-motion-surface");
  await Promise.resolve();

  layout.finish();

  expect(document.activeElement).toBe(control);
  expect(control.isConnected).toBe(true);
  expect(painted?.style.transform).toBe("none");
  expect((scroll.parentElement as HTMLElement).style.transform).toBe("none");
  await Promise.resolve();
  layout.mutate(() => {
    control.textContent = "Compact";
  }, 220);
  expect(document.activeElement).toBe(control);
  expect(control.textContent).toBe("Compact");
  layout.dispose();
});
