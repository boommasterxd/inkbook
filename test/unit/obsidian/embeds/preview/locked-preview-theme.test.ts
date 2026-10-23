// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { ActiveScenePreviewHandoff } from "../../../../../src/obsidian/embeds/active-scene/active-scene-handoff";
import { createInkbookLockedPreview } from "../../../../../src/obsidian/embeds/preview/locked-preview";
import { createHtmlElement, installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { lockedPreviewRoot } from "../../../../fixtures/obsidian/locked-preview";

beforeEach(() => installObsidianDomHelpers());
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function preparedPreview() {
  const button = document.body.appendChild(createHtmlElement("button"));
  const descriptor = {
    aspectRatio: 1,
    contentIdentity: { outputHash: "a".repeat(64), revision: 1 },
    safeSvg:
      '<svg xmlns="http://www.w3.org/2000/svg"><metadata>snapshot</metadata>' +
      '<style id="inkbook-theme">file stylesheet</style><g>' +
      '<path class="inkbook-theme-guide" d="M0 0L1 1"/></g></svg>',
  };
  const preview = createInkbookLockedPreview(button, descriptor, immediateWorkScheduler());
  return { button, descriptor, preview };
}

it("isolates canonical preview paint and updates schemes without rebuilding the SVG", async () => {
  const { button, descriptor, preview } = preparedPreview();
  const surface = lockedPreviewRoot(button);
  const create = vi.spyOn(surface, "createElementNS");
  const fetch = vi.spyOn(window, "fetch");
  await preview.ensureReady();
  const svg = surface.querySelector("svg");
  const frame = button.firstElementChild?.shadowRoot?.querySelector("iframe");
  expect(frame?.getAttribute("sandbox")).toBe("allow-same-origin");
  expect(frame?.hasAttribute("inert")).toBe(true);
  expect(frame?.tabIndex).toBe(-1);
  expect(frame?.getAttribute("aria-hidden")).toBe("true");
  expect(button.querySelector("svg")).toBeNull();
  expect(svg?.ownerDocument).toBe(surface);
  expect(svg?.querySelector("path")?.getAttribute("d")).toBe("M0 0L1 1");
  expect(svg?.querySelector("metadata, style")).toBeNull();
  expect(svg?.getAttribute("aria-hidden")).toBe("true");
  expect(svg?.getAttribute("focusable")).toBe("false");
  const styles = [...surface.head.querySelectorAll("style")];
  expect(styles).toHaveLength(1);
  const allocations = create.mock.calls.length;
  for (const scheme of ["light", "dark", "light"] as const) {
    preview.setColorScheme(scheme);
    preview.refresh();
    preview.setDescriptor(descriptor);
    await preview.ensureReady();
    expect(surface.documentElement.dataset.inkbookScheme).toBe(scheme);
    expect(surface.querySelector("svg")).toBe(svg);
    expect([...surface.head.querySelectorAll("style")]).toEqual(styles);
  }
  expect(create).toHaveBeenCalledTimes(allocations);
  preview.setDescriptor({
    ...descriptor,
    contentIdentity: { ...descriptor.contentIdentity, revision: 2 },
    safeSvg: descriptor.safeSvg.replace("M0 0L1 1", "M0 0L2 2"),
  });
  await preview.ensureReady();
  expect(surface.querySelector("svg")).not.toBe(svg);
  expect(surface.querySelector("path")?.getAttribute("d")).toBe("M0 0L2 2");
  expect([...surface.head.querySelectorAll("style")]).toEqual(styles);
  expect(fetch).not.toHaveBeenCalled();
  preview.dispose();
  expect(surface.querySelector("svg, style")).toBeNull();
  expect(button.firstElementChild?.shadowRoot?.querySelector("iframe")).toBeNull();
});

it("repairs a pop-out frame document using the retained SVG and current scheme", async () => {
  const { button, preview } = preparedPreview();
  const target = new Window();
  try {
    await preview.ensureReady();
    const originalDocument = lockedPreviewRoot(button);
    const svg = originalDocument.querySelector("svg");
    const frame = button.firstElementChild?.shadowRoot?.querySelector("iframe");
    if (frame === null || frame === undefined) throw new Error("Missing preview frame");
    const freshDocument = target.document as unknown as Document;
    button.hidden = true;
    target.document.body.append(target.document.adoptNode(button as never));
    expect(button.ownerDocument).toBe(target.document);
    // Native iframe contexts reset during cross-window adoption; Happy DOM retains its context.
    Object.defineProperty(frame, "contentDocument", { configurable: true, value: freshDocument });
    const create = vi.spyOn(freshDocument, "createElementNS");
    preview.setColorScheme("dark");
    frame.dispatchEvent(new Event("load"));
    await preview.ensureReady();
    expect(freshDocument.querySelector("svg")).toBe(svg);
    expect(svg?.ownerDocument).toBe(freshDocument);
    expect(originalDocument.querySelector("svg, style")).toBeNull();
    expect(freshDocument.documentElement.dataset.inkbookScheme).toBe("dark");
    expect(freshDocument.head.querySelectorAll("style")).toHaveLength(1);
    expect(
      create.mock.calls.filter(([namespace]) => namespace === "http://www.w3.org/2000/svg"),
    ).toHaveLength(0);
    preview.refresh();
    expect(freshDocument.querySelectorAll("svg")).toHaveLength(1);
    expect(freshDocument.head.querySelectorAll("style")).toHaveLength(1);
  } finally {
    preview.dispose();
    target.close();
  }
});

it("retains the connected hidden preview across active handoff and lock", async () => {
  const { button, preview } = preparedPreview();
  const root = document.body.appendChild(createHtmlElement("div"));
  root.append(button);
  await preview.ensureReady();
  const surface = lockedPreviewRoot(button);
  const svg = surface.querySelector("svg");
  const handoff = new ActiveScenePreviewHandoff({
    root,
    container: root,
    motion: "reduced",
    preview: button,
    refreshPreview: preview.refresh,
    workScheduler: immediateWorkScheduler(),
  });
  try {
    handoff.ready();
    expect(button.isConnected).toBe(true);
    expect(button.hidden).toBe(true);
    preview.setColorScheme("dark");
    expect(surface.documentElement.dataset.inkbookScheme).toBe("dark");
    handoff.restorePreview();
    expect(button.isConnected).toBe(true);
    expect(button.hidden).toBe(false);
    expect(lockedPreviewRoot(button)).toBe(surface);
    expect(surface.querySelector("svg")).toBe(svg);
  } finally {
    handoff.dispose();
    preview.dispose();
  }
});

it("does not recreate surface resources after disposal or a late load event", async () => {
  const { button, descriptor, preview } = preparedPreview();
  await preview.ensureReady();
  const surface = lockedPreviewRoot(button);
  const frame = button.firstElementChild?.shadowRoot?.querySelector("iframe");
  const create = vi.spyOn(surface, "createElementNS");
  preview.dispose();
  preview.setDescriptor(descriptor);
  preview.setColorScheme("dark");
  preview.refresh();
  frame?.dispatchEvent(new Event("load"));
  await preview.ensureReady();
  await expect(preview.setSource("app://disposed.svg")).resolves.toBeUndefined();
  expect(
    create.mock.calls.filter(([namespace]) => namespace === "http://www.w3.org/2000/svg"),
  ).toHaveLength(0);
  expect(surface.querySelector("svg, style")).toBeNull();
});
