// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ActiveScenePreviewHandoff } from "../../../src/obsidian/embeds/active-scene-handoff";
import { serializeSvgEnvelope } from "../../../src/persistence/documents/svg-envelope";
import { createSnapshot } from "../../unit/persistence/serialization/fixtures";

import { createInkbookLockedPreview } from "../../../src/obsidian/embeds/locked-preview";
import { immediateWorkScheduler } from "../../fixtures/obsidian/immediate-work-scheduler";
import { createHtmlElement, installObsidianDomHelpers } from "../../adapters/obsidian/dom";

declare function setImmediate(callback: () => void): void;

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
  // Let happy-dom's WeakRef targets expire before allocating the next capacity fixture.
  await new Promise<void>((resolve) => setImmediate(resolve));
});

it("coalesces hidden autosave previews into one bounded tree and reuses unchanged identities", async () => {
  const button = createHtmlElement("button");
  const safeSvg = `<svg xmlns="http://www.w3.org/2000/svg"><metadata></metadata>${'<path d="M0 0L1 1"/>'.repeat(10_000)}</svg>`;
  const create = vi.spyOn(document, "createElementNS");
  const parser = vi.spyOn(window.DOMParser.prototype, "parseFromString");
  const importer = vi.spyOn(document, "importNode");
  const descriptor = (revision: number) => ({
    safeSvg,
    aspectRatio: revision,
    contentIdentity: { revision, outputHash: "a".repeat(64) },
  });
  const preview = createInkbookLockedPreview(button, descriptor(1), immediateWorkScheduler());
  expect(create.mock.calls).toEqual([["http://www.w3.org/1999/xhtml", "div"]]);
  await preview.ensureReady();
  const original = button.querySelector("svg");
  expect(original).not.toBeNull();
  expect(create).toHaveBeenCalledTimes(10_002);
  button.hidden = true;
  for (let revision = 2; revision <= 20; revision += 1) {
    preview.setDescriptor(descriptor(revision));
    preview.refresh();
  }
  expect(create).toHaveBeenCalledTimes(10_002);
  expect(button.querySelector("svg")).toBe(original);
  await preview.ensureReady();
  button.hidden = false;
  preview.refresh();
  expect(create).toHaveBeenCalledTimes(20_003);
  expect(parser).not.toHaveBeenCalled();
  expect(importer).not.toHaveBeenCalled();
  expect(button.querySelectorAll("path")).toHaveLength(10_000);
  expect(button.firstElementChild?.getAttribute("style")).toContain("20");
  const current = button.querySelector("svg");
  preview.refresh();
  preview.setDescriptor(descriptor(20));
  await preview.ensureReady();
  expect(button.querySelector("svg")).toBe(current);
  expect(create).toHaveBeenCalledTimes(20_003);
  preview.dispose();
  preview.setDescriptor(descriptor(21));
  preview.refresh();
  await preview.ensureReady();
  expect(create).toHaveBeenCalledTimes(20_003);
  expect(parser).not.toHaveBeenCalled();
  expect(importer).not.toHaveBeenCalled();
});

it("does no fetch or SVG construction for hidden saves and prepares only the latest source on lock", async () => {
  const button = createHtmlElement("button");
  const root = createHtmlElement("div");
  root.append(button);
  const svg = serializeSvgEnvelope(createSnapshot(), 148.6, {
    background: [],
    highlights: [],
    content: ['<path d="M0 0L1 1" fill="none" stroke="#112233FF"/>'.repeat(10_000)],
  });
  const fetch = vi.spyOn(window, "fetch").mockImplementation(async () => new Response(svg));
  const create = vi.spyOn(document, "createElementNS");
  const preview = createInkbookLockedPreview(
    button,
    {
      safeSvg: svg,
      aspectRatio: 1,
      contentIdentity: { revision: 0, outputHash: "a".repeat(64) },
    },
    immediateWorkScheduler(),
  );
  await preview.ensureReady();
  const oldSvg = button.querySelector("svg");
  expect(oldSvg).not.toBeNull();
  const initialNodes = create.mock.calls.length;
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
  expect(previewBounds).toHaveBeenCalledOnce();
  handoff.ready();
  for (let revision = 1; revision <= 20; revision += 1) {
    await handoff.setPreviewSource(`app://saved.svg?revision=${String(revision)}`);
    await Promise.resolve();
  }
  expect(fetch).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledTimes(initialNodes);
  expect(adoptedIdentity).toBeUndefined();
  expect(button.isConnected).toBe(false);
  await handoff.ensurePreviewReady();
  expect(fetch).toHaveBeenCalledExactlyOnceWith("app://saved.svg?revision=20", expect.anything());
  // One SVG root, three render groups, and the 10,000 retained paths.
  expect(create).toHaveBeenCalledTimes(initialNodes + 10_004);
  expect(adoptedIdentity).toMatchObject({ revision: createSnapshot().revision });
  const appendChild = root.appendChild.bind(root);
  const connectedSvgs: (SVGSVGElement | null)[] = [];
  vi.spyOn(root, "appendChild").mockImplementation(<T extends Node>(node: T): T => {
    expect(node).toBe(button);
    connectedSvgs.push(button.querySelector("svg"));
    return appendChild(node);
  });
  handoff.restorePreview();
  expect(connectedSvgs).toHaveLength(1);
  expect(connectedSvgs[0]).not.toBeNull();
  expect(connectedSvgs[0]).not.toBe(oldSvg);
  expect(button.querySelectorAll("path")).toHaveLength(10_000);
  handoff.dispose();
  preview.dispose();
  expect(previewBounds).toHaveBeenCalledOnce();
  expect(containerBounds).not.toHaveBeenCalled();
});
