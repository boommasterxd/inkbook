// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDesktopMenuMotion } from "../../../../src/obsidian/menus/menu-motion";
import { createHtmlElement, installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(installObsidianDomHelpers);

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("desktop native menu motion", () => {
  it("leaves touch and narrow native menu presentations entirely host-owned", () => {
    installMatchMedia(false);
    const fixture = menuFixture("surface");

    const motion = createDesktopMenuMotion({
      kind: "surface",
      marker: fixture.marker,
      motionSource: fixture.source,
      ownerWindow: window,
    });

    expect(motion).toBeUndefined();
    expect(fixture.surface.classList.contains("inkbook-menu-motion")).toBe(false);
  });

  it("staggers owned Style cards and leaves a non-interactive exit clone", () => {
    vi.useFakeTimers();
    installMatchMedia(true);
    const fixture = menuFixture("cards");

    const motion = createDesktopMenuMotion({
      kind: "cards",
      marker: fixture.marker,
      motionSource: fixture.source,
      ownerWindow: window,
    });

    expect(motion?.bounds).toEqual({ height: 240, left: 80, top: 120, width: 360 });
    expect(fixture.surface.classList.contains("inkbook-menu-motion-cards")).toBe(true);
    expect(
      fixture.cards.map((card) => card.style.getPropertyValue("--inkbook-menu-card-delay")),
    ).toEqual(["0ms", "50ms", "100ms"]);
    expect(
      fixture.cards.map((card) => card.style.getPropertyValue("--inkbook-menu-card-exit-delay")),
    ).toEqual(["100ms", "50ms", "0ms"]);

    motion?.exit();
    const clone = document.querySelector<HTMLElement>(".inkbook-menu-exit-clone");
    expect(clone?.getAttribute("aria-hidden")).toBe("true");
    expect(clone?.classList.contains("inkbook-menu-presence-exiting")).toBe(true);
    motion?.exit();
    expect(document.querySelectorAll(".inkbook-menu-exit-clone")).toHaveLength(1);
    vi.runAllTimers();
    expect(document.querySelector(".inkbook-menu-exit-clone")).toBeNull();
  });

  it("morphs a replacement surface from the previous menu bounds", () => {
    installMatchMedia(true);
    const fixture = menuFixture("surface");

    createDesktopMenuMotion({
      kind: "surface",
      marker: fixture.marker,
      motionSource: fixture.source,
      ownerWindow: window,
      previousBounds: { height: 120, left: 170, top: 180, width: 180 },
    });

    expect(fixture.surface.classList.contains("inkbook-menu-presence-morphing")).toBe(true);
    expect(fixture.surface.style.getPropertyValue("--inkbook-menu-morph-scale-x")).toBe("0.5");
    expect(fixture.surface.style.getPropertyValue("--inkbook-menu-morph-scale-y")).toBe("0.5");
    expect(fixture.surface.style.getPropertyValue("--inkbook-menu-morph-translate-x")).toBe("0px");
    expect(fixture.surface.style.getPropertyValue("--inkbook-menu-morph-translate-y")).toBe("0px");
  });

  it("suppresses interpolation and exit clones for an explicit reduced-motion preference", () => {
    installMatchMedia(true);
    const fixture = menuFixture("surface");
    fixture.source.parentElement!.dataset.inkbookMotion = "reduced";

    const motion = createDesktopMenuMotion({
      kind: "surface",
      marker: fixture.marker,
      motionSource: fixture.source,
      ownerWindow: window,
    });

    expect(fixture.surface.style.getPropertyValue("--inkbook-menu-motion-duration")).toBe("0ms");
    motion?.exit();
    expect(document.querySelector(".inkbook-menu-exit-clone")).toBeNull();
  });
});

function menuFixture(kind: "cards" | "surface") {
  const root = createHtmlElement("div");
  root.className = "inkbook-root";
  root.dataset.inkbookMotion = "full";
  const source = createHtmlElement("button");
  root.append(source);
  document.body.append(root);
  const surface = createHtmlElement("div");
  surface.className = "menu";
  surface.getBoundingClientRect = () =>
    ({ height: 240, left: 80, top: 120, width: 360 }) as DOMRect;
  const marker = createHtmlElement("span");
  const cards: HTMLElement[] = [];
  if (kind === "cards") {
    marker.className = "inkbook-menu-controls";
    for (let index = 0; index < 3; index += 1) {
      const card = createHtmlElement("section");
      card.className = "inkbook-menu-control";
      cards.push(card);
      marker.append(card);
    }
  } else marker.className = "inkbook-menu-motion-marker";
  surface.append(marker);
  document.body.append(surface);
  return { cards, marker, source, surface };
}

function installMatchMedia(matches: boolean): void {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches } as MediaQueryList);
}
