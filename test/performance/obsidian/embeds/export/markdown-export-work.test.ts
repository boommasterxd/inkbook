// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import { createReadingViewPostProcessor } from "../../../../../src/obsidian/embeds/reading-view";
import {
  createMarkdownExportFixture,
  exportDescriptor,
} from "../../../../fixtures/obsidian/markdown-export";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { createSvgDomWorkObserver } from "../../../../fixtures/obsidian/svg-dom-work";
import { printPaginationFixture } from "../../../../fixtures/obsidian/print-pagination";
import * as previewBuilder from "../../../../../src/obsidian/embeds/preview/safe-preview-builder";
import * as exportCuts from "../../../../../src/domain/export/export-pagination";
import * as exportGeometry from "../../../../../src/persistence/export/export-geometry";
import { DocumentWorkerRuntime } from "../../../../../src/persistence/worker/runtime/public";
import * as staticFragments from "../../../../../src/persistence/export/static-export-fragments";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function capacityFixture() {
  const fixture = createMarkdownExportFixture(
    "!inkbook[[capacity.svg|One]]\n\n!inkbook[[capacity.svg|Two]]",
    '<div><p>!inkbook<a href="capacity.svg">One</a></p></div><div><p>!inkbook<a href="capacity.svg">Two</a></p></div>',
    exportDescriptor(
      '<path class="inkbook-theme-stroke" d="M10 5000L30 5020" stroke="#000000FF"/>'.repeat(10_000),
    ),
  );
  document.body.append(fixture.root);
  return fixture;
}

it("builds every saved path once with bounded DOM work between central admissions", async () => {
  const fixture = capacityFixture();
  const create = vi.spyOn(document, "createElementNS");
  const attributes = vi.spyOn(window.Element.prototype, "setAttribute");
  const append = vi.spyOn(window.Element.prototype, "append");
  const imported = vi.spyOn(document, "importNode");
  const parse = vi.spyOn(window.DOMParser.prototype, "parseFromString");
  const measure = vi.spyOn(window.Element.prototype, "getBoundingClientRect");
  const targetStyle = vi.spyOn(window, "getComputedStyle");
  const prepareGeometry = vi.spyOn(exportGeometry, "prepareExportGeometry");
  const execute = vi.spyOn(DocumentWorkerRuntime.prototype, "execute");
  // A controlled admission admits 256 real DOM creations, with four path writes each.
  const { observe, shouldYield } = createSvgDomWorkObserver(
    { create, attributes, append },
    { create: 256, attributes: 256 * 4 + 12, append: 256 },
  );
  const checkpoint = vi.fn(() => {
    observe();
    return undefined;
  });
  const nextFrame = vi.fn(async () => {});
  const scheduler = {
    ...immediateWorkScheduler(shouldYield),
    checkpoint,
    nextFrame,
  };
  await createReadingViewPostProcessor({
    ...fixture.ports,
    workScheduler: () => scheduler,
  })(fixture.root, fixture.context);
  observe();
  expect(fixture.root.querySelectorAll("path")).toHaveLength(10_000);
  // Each occurrence adds a text/opaque cover pair to its three wrappers and SVG/use.
  expect(create.mock.calls.length).toBeLessThanOrEqual(10_000 + 4 + 7 * 2);
  expect(create.mock.calls.filter(([, name]) => name === "path")).toHaveLength(10_000);
  // Text/cover painting adds exactly fourteen attributes and one append per occurrence.
  expect(attributes.mock.calls.length).toBeLessThanOrEqual(10_000 * 4 + 58 + 14 * 2);
  expect(append.mock.calls.length).toBeLessThanOrEqual(10_000 + 4 + 5 * 2);
  expect(create.mock.calls.filter(([, name]) => name === "text")).toHaveLength(2);
  expect(create.mock.calls.filter(([, name]) => name === "rect")).toHaveLength(2);
  expect(fixture.root.querySelectorAll("defs")).toHaveLength(1);
  expect(fixture.root.querySelectorAll("use")).toHaveLength(2);
  // Include the separate static-fragment preparation admission, even for whole-graphic fallback.
  expect(checkpoint.mock.calls.length).toBeLessThanOrEqual(68);
  expect(prepareGeometry).toHaveBeenCalledOnce();
  expect(execute.mock.calls.map(([request]) => request.type)).toEqual(["prepare-export-geometry"]);
  expect(nextFrame).not.toHaveBeenCalled();
  expect(measure).not.toHaveBeenCalled();
  expect(targetStyle).toHaveBeenCalledExactlyOnceWith(fixture.root);
  for (const root of fixture.root.querySelectorAll<HTMLElement>(".inkbook-static-export")) {
    expect(root.dataset.inkbookScheme).toBe("light");
  }
  expect(imported).not.toHaveBeenCalled();
  expect(parse).not.toHaveBeenCalled();
  expect(fixture.readMarkdownSource).toHaveBeenCalledExactlyOnceWith("notes/note.md");
  expect(fixture.prepareStaticExport).toHaveBeenCalledExactlyOnceWith("capacity.svg");
  expect(fixture.recognize).toHaveBeenCalledExactlyOnceWith("capacity.svg", window);
  expect(create.mock.results.every((result) => (result.value as Element).isConnected)).toBe(true);
  fixture.unload();
  expect(fixture.root.querySelector("svg")).toBeNull();
  for (const result of create.mock.results)
    expect((result.value as Element).isConnected).toBe(false);
});

it("bounds print publication and host reads while reusing the complete ten-thousand-path drawing", async () => {
  const fixture = await printPaginationFixture({
    paths: 10_000,
    height: 180_000,
    width: 657,
    occurrences: 3,
    nativeScale: 0.75,
    deferStart: true,
  });
  const { rootBounds } = fixture.nativeRoot!;
  const originalStyle = fixture.root.getAttribute("style");
  const originals = fixture.containers.map((container) => [...container.childNodes]);
  const create = vi.spyOn(document, "createElementNS");
  const attributes = vi.spyOn(window.Element.prototype, "setAttribute");
  const build = vi.spyOn(previewBuilder, "createPreviewSvgAsync");
  const prepare = vi.spyOn(exportCuts, "prepareExportCutsSteps");
  const parse = vi.spyOn(window.DOMParser.prototype, "parseFromString");
  const fragments = vi.spyOn(staticFragments, "prepareStaticExportFragments");
  const rootStyle = vi.spyOn(fixture.root.style, "setProperty");
  fixture.styles.mockClear();
  fixture.controller.start();
  expect(rootStyle.mock.calls.map(([name]) => name)).toEqual([
    "max-inline-size",
    "--inkbook-native-pdf-maximum",
  ]);
  expect(fixture.layoutReads).toHaveLength(1);
  fixture.layoutReads.length = 0;
  fixture.print(true);
  const pieces = fixture.root.querySelectorAll(".inkbook-export-piece");
  expect(pieces.length).toBeGreaterThan(0);
  expect(pieces.length).toBeLessThanOrEqual(256);
  expect(fixture.containers[2]?.querySelector(".inkbook-export-piece")).toBeNull();
  for (const container of fixture.containers.slice(0, 2)) {
    const fragments = container.querySelectorAll<HTMLElement>(".inkbook-export-piece");
    expect(fragments[0]?.dataset.inkbookRangeStart).toBe("0");
    expect(fragments[fragments.length - 1]?.dataset.inkbookRangeEnd).toBe("180000");
  }
  expect(fixture.root.querySelectorAll("path")).toHaveLength(10_000);
  expect(fixture.root.querySelectorAll("defs")).toHaveLength(1);
  // Every native layout/style read sees empty viewports across all three occurrences.
  // Earlier pieces may affect later page boxes, but their drawing references activate last.
  expect(fixture.layoutReads.length).toBeGreaterThan(0);
  // Native admission adds one root fragment-count read before references activate.
  expect(fixture.layoutReads.length).toBeLessThanOrEqual(3 * 4 + 2);
  expect(fixture.layoutReads.every((read) => read.references === 0)).toBe(true);
  expect(fixture.layoutReads.some((read) => read.pieces > 0)).toBe(true);
  expect(fixture.root.querySelectorAll("svg[role='img'] use")).toHaveLength(pieces.length + 1);
  expect(create.mock.calls.filter(([, name]) => name === "path")).toHaveLength(0);
  // At most one text/cover pair per occurrence, independent of path and piece counts.
  expect(create.mock.calls.filter(([, name]) => name === "text")).toHaveLength(2);
  expect(create.mock.calls.filter(([, name]) => name === "rect")).toHaveLength(2);
  expect(create.mock.calls.length).toBeLessThanOrEqual(256 * 5 + 3 * 2);
  expect(attributes.mock.calls.length).toBeLessThanOrEqual(256 * 22 + 3 * 4 + 3 * 14);
  expect(fixture.pages).toHaveBeenCalledTimes(4);
  expect(fixture.styles).toHaveBeenCalledTimes(5);
  // One shared root correction, independent of the three occurrences and 10,000 paths.
  expect(create.mock.calls.filter(([, name]) => name === "span")).toHaveLength(0);
  expect(rootBounds).not.toHaveBeenCalled();
  expect(rootStyle).toHaveBeenCalledTimes(2);
  expect(fixture.styles.mock.calls.filter(([element]) => element === fixture.root)).toHaveLength(2);
  for (const boundary of fixture.measuredBounds) expect(boundary.mock.calls).toHaveLength(1);
  expect(build).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(parse).not.toHaveBeenCalled();
  expect(fragments).not.toHaveBeenCalled();
  fixture.controller.dispose();
  expect(fixture.root.getAttribute("style")).toBe(originalStyle);
  expect(rootStyle).toHaveBeenCalledTimes(3);
  expect(fixture.root.classList.contains("inkbook-native-pdf-export")).toBe(false);
  for (const [index, container] of fixture.containers.entries())
    expect([...container.childNodes]).toEqual(originals[index]);
  create.mockClear();
  fixture.print(true);
  expect(create).not.toHaveBeenCalled();
});

it("drops detached capacity work without further DOM writes after lifecycle cancellation", async () => {
  const fixture = capacityFixture();
  const create = vi.spyOn(document, "createElementNS");
  const attributes = vi.spyOn(window.Element.prototype, "setAttribute");
  let release!: () => void;
  const checkpoint = vi.fn(() =>
    create.mock.calls.length < 256
      ? undefined
      : new Promise<void>((resolve) => {
          release = resolve;
        }),
  );
  const scheduler = {
    ...immediateWorkScheduler(() => create.mock.calls.length >= 256),
    checkpoint,
  };
  const pending = createReadingViewPostProcessor({
    ...fixture.ports,
    workScheduler: () => scheduler,
  })(fixture.root, fixture.context);
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(256));
  expect(fixture.root.querySelector("svg")).toBeNull();
  const writes = attributes.mock.calls.length;
  fixture.unload();
  release();
  await pending;
  expect(create).toHaveBeenCalledTimes(256);
  expect(attributes).toHaveBeenCalledTimes(writes);
  expect(fixture.root.querySelector("svg")).toBeNull();
  expect(fixture.root.querySelector("a")?.getAttribute("href")).toBe("capacity.svg");
  for (const result of create.mock.results)
    expect((result.value as Element).isConnected).toBe(false);
});
