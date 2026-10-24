// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ActiveScenePreviewHandoff } from "../../../../../src/obsidian/embeds/active-scene/active-scene-handoff";
import * as previewBuilder from "../../../../../src/obsidian/embeds/preview/safe-preview-builder";
import { serializeSvgEnvelope } from "../../../../../src/persistence/documents/svg-envelope";
import { createSnapshot } from "../../../../unit/persistence/serialization/fixtures";

import { createInkbookLockedPreview } from "../../../../../src/obsidian/embeds/preview/locked-preview";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { lockedPreviewRoot } from "../../../../fixtures/obsidian/locked-preview";
import { createHtmlElement, installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";

declare function setImmediate(callback: () => void): void;

function observeSvgAllocations(button: HTMLButtonElement) {
  const create = vi.spyOn(lockedPreviewRoot(button), "createElementNS");
  return {
    create,
    count: () =>
      create.mock.calls.filter(([namespace]) => namespace === "http://www.w3.org/2000/svg").length,
  };
}

function observePreviewBuildAllocations() {
  const original = previewBuilder.createPreviewSvgAsync;
  const counts = new Map<Document, () => number>();
  vi.spyOn(previewBuilder, "createPreviewSvgAsync").mockImplementation(
    (target, source, options) => {
      if (!counts.has(target)) {
        const create = vi.spyOn(target, "createElementNS");
        counts.set(
          target,
          () =>
            create.mock.calls.filter(([namespace]) => namespace === "http://www.w3.org/2000/svg")
              .length,
        );
      }
      return original(target, source, options);
    },
  );
  return () => [...counts.values()].reduce((total, count) => total + count(), 0);
}

beforeEach(() => {
  installObsidianDomHelpers();
  vi.spyOn(window, "setTimeout").mockImplementation((callback) => {
    queueMicrotask(callback as () => void);
    return 1 as unknown as ReturnType<typeof window.setTimeout>;
  });
});
afterEach(async () => {
  // Restoring spies alone retains recorded SVG nodes in Vitest's dirty mock registry.
  vi.clearAllMocks();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  // Let happy-dom's WeakRef targets expire before allocating the next capacity fixture.
  await new Promise<void>((resolve) => setImmediate(resolve));
});

it("defers hidden descriptor trees across saves and builds only the latest on demand", async () => {
  const button = document.body.appendChild(createHtmlElement("button"));
  const safeSvg = `<svg xmlns="http://www.w3.org/2000/svg"><metadata></metadata>${'<path d="M0 0L1 1"/>'.repeat(10_000)}</svg>`;
  const parser = vi.spyOn(window.DOMParser.prototype, "parseFromString");
  const importer = vi.spyOn(document, "importNode");
  const descriptor = (revision: number) => ({
    safeSvg,
    aspectRatio: revision,
    contentIdentity: { revision, outputHash: "a".repeat(64) },
  });
  const preview = createInkbookLockedPreview(button, descriptor(1), immediateWorkScheduler());
  const { create, count: svgAllocations } = observeSvgAllocations(button);
  await preview.ensureReady();
  const original = lockedPreviewRoot(button).querySelector("svg");
  expect(original).not.toBeNull();
  expect(svgAllocations()).toBe(10_001);
  expect(create).toHaveBeenCalledTimes(10_001);
  button.hidden = true;
  for (let revision = 2; revision <= 20; revision += 1) {
    preview.setDescriptor(descriptor(revision));
    preview.refresh();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(svgAllocations()).toBe(10_001);
  expect(lockedPreviewRoot(button).querySelector("svg")).toBe(original);
  await preview.ensureReady();
  button.hidden = false;
  preview.refresh();
  expect(svgAllocations()).toBe(20_002);
  expect(create).toHaveBeenCalledTimes(20_002);
  expect(parser).not.toHaveBeenCalled();
  expect(importer).not.toHaveBeenCalled();
  expect(lockedPreviewRoot(button).querySelectorAll("path")).toHaveLength(10_000);
  expect(button.firstElementChild?.getAttribute("style")).toContain("20");
  const current = lockedPreviewRoot(button).querySelector("svg");
  preview.setColorScheme("dark");
  preview.refresh();
  preview.setDescriptor(descriptor(20));
  await preview.ensureReady();
  expect(lockedPreviewRoot(button).querySelector("svg")).toBe(current);
  for (const ratio of [2, 0.5, 1]) {
    preview.setAspectRatio(ratio);
    preview.refresh();
  }
  expect(svgAllocations()).toBe(20_002);
  expect(create).toHaveBeenCalledTimes(20_002);
  preview.dispose();
  preview.setDescriptor(descriptor(21));
  preview.refresh();
  await preview.ensureReady();
  expect(svgAllocations()).toBe(20_002);
  expect(parser).not.toHaveBeenCalled();
  expect(importer).not.toHaveBeenCalled();
});

it("does no fetch or SVG construction for hidden saves and prepares only the latest source on lock", async () => {
  const svgAllocations = observePreviewBuildAllocations();
  const button = document.body.appendChild(createHtmlElement("button"));
  const root = createHtmlElement("div");
  root.append(button);
  document.body.append(root);
  const svg = serializeSvgEnvelope(createSnapshot(), 148.6, {
    background: [],
    highlights: [],
    content: ['<path d="M0 0L1 1" fill="none" stroke="#112233FF"/>'.repeat(10_000)],
  });
  const fetch = vi.spyOn(window, "fetch").mockImplementation(async () => new Response(svg));
  const preview = createInkbookLockedPreview(
    button,
    {
      safeSvg: svg,
      aspectRatio: 1,
      contentIdentity: { revision: 0, outputHash: "a".repeat(64) },
    },
    immediateWorkScheduler(),
  );
  const drawingDocument = lockedPreviewRoot(button);
  await preview.ensureReady();
  const oldSvg = lockedPreviewRoot(button).querySelector("svg");
  expect(oldSvg).not.toBeNull();
  const initialNodes = svgAllocations();
  const previewBounds = vi.spyOn(button, "getBoundingClientRect");
  const containerBounds = vi.spyOn(root, "getBoundingClientRect");
  let adoptedIdentity: unknown;
  const handoff = new ActiveScenePreviewHandoff({
    root,
    container: root,
    motion: "reduced",
    preview: button,
    workScheduler: immediateWorkScheduler(),
    refreshPreview: preview.refresh,
    ensurePreviewReady: preview.ensureReady,
    setPreviewSource: async (source) => {
      adoptedIdentity = await preview.setSource(source);
    },
  });
  handoff.onUnlockSettled = preview.releaseHiddenSurface;
  expect(previewBounds).toHaveBeenCalledOnce();
  handoff.ready();
  for (let revision = 1; revision <= 20; revision += 1) {
    await handoff.setPreviewSource(`app://saved.svg?revision=${String(revision)}`);
    preview.setDescriptor({
      safeSvg: svg,
      aspectRatio: 1,
      contentIdentity: { revision, outputHash: "b".repeat(64) },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(fetch).not.toHaveBeenCalled();
  expect(svgAllocations()).toBe(initialNodes);
  expect(adoptedIdentity).toBeUndefined();
  expect(button.isConnected).toBe(true);
  expect(button.hidden).toBe(true);
  expect(drawingDocument.querySelector("svg, style")).toBeNull();
  expect(button.firstElementChild?.shadowRoot?.querySelector("iframe")).toBeNull();
  await handoff.ensurePreviewReady();
  expect(fetch).toHaveBeenCalledExactlyOnceWith("app://saved.svg?revision=20", expect.anything());
  // One SVG root, three render groups, and the 10,000 retained paths.
  expect(svgAllocations()).toBe(initialNodes + 10_004);
  expect(adoptedIdentity).toMatchObject({ revision: createSnapshot().revision });
  handoff.restorePreview();
  expect(button.isConnected).toBe(true);
  expect(button.hidden).toBe(false);
  expect(lockedPreviewRoot(button)).not.toBe(drawingDocument);
  expect(lockedPreviewRoot(button).querySelector("svg")).not.toBe(oldSvg);
  expect(lockedPreviewRoot(button).querySelectorAll("path")).toHaveLength(10_000);
  handoff.dispose();
  preview.dispose();
  expect(drawingDocument.querySelector("svg, style")).toBeNull();
  expect(button.firstElementChild?.shadowRoot?.querySelector("iframe")).toBeNull();
  expect(previewBounds).toHaveBeenCalledOnce();
  expect(containerBounds).not.toHaveBeenCalled();
});
