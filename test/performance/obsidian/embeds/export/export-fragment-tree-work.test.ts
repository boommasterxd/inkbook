// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import {
  createExportPage,
  prepareExportDrawing,
  type ExportDrawing,
} from "../../../../../src/obsidian/embeds/export/export-pages";
import type { ExportFragmentTree } from "../../../../../src/obsidian/embeds/export/export-fragment-tree";
import {
  exportFragmentFixture,
  resolveExportPagePaths,
} from "../../../../fixtures/obsidian/export-fragment-tree";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { createSvgDomWorkObserver } from "../../../../fixtures/obsidian/svg-dom-work";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

it("indexes ten thousand retained paths once and instantiates only intersecting page subtrees", async () => {
  const count = 10_000;
  const fixture = exportFragmentFixture([
    Array.from({ length: count }, (_, index) => ({
      markup: `<path d="M1 ${index * 3 + 0.25}L2 ${index * 3 + 1.25}"/>`,
      minY: index * 3 + 0.25,
      maxY: index * 3 + 1.25,
      background: false,
    })),
  ]);
  const work = observeExportDomWork();
  const { create, attributes, append, clone, imported } = work;
  const { observe } = createSvgDomWorkObserver(work, { create: 3, attributes: 8, append: 4 });
  const drawing = await prepareExportDrawing(fixture.svg, fixture.fragments, {
    scheduler: {
      ...immediateWorkScheduler(),
      checkpoint: () => {
        observe();
        return undefined;
      },
    },
    signal: new AbortController().signal,
  });
  observe();
  const leaves = Math.ceil(count / 32);
  expect(create.mock.calls.length).toBeLessThanOrEqual(leaves * 2 + 2);
  expect(attributes.mock.calls.length).toBeLessThanOrEqual(count + leaves * 2 + 6);
  expect(append.mock.calls.length).toBeLessThanOrEqual(count + leaves + 5);
  expect(create.mock.calls.filter(([, name]) => name === "path")).toHaveLength(0);
  expect(drawing.fragments).toBeDefined();
  create.mockClear();
  const query = observeTreeQueries(drawing);
  const pages = Array.from({ length: 3 }, (_, index) =>
    createExportPage(document, query.drawing, {
      start: index * 10_000,
      end: (index + 1) * 10_000,
    }),
  );
  // Sorted ranges visit logarithmic tree boundaries and at most two 32-entry leaves per page.
  expect(query.visits()).toBeLessThanOrEqual(3 * (64 + 20));
  let instantiated = 0;
  for (const [index, page] of pages.entries()) {
    const start = index * 10_000;
    const end = start + 10_000;
    const expected = fixture.paths.filter((_, ordinal) => {
      const range = fixture.fragments[ordinal]!;
      return range.minY <= end && range.maxY >= start;
    });
    const paths = resolveExportPagePaths(fixture.svg, page);
    expect(paths).toEqual(expected);
    instantiated += paths.length;
  }
  // The single boundary-crossing path appears on both affected pages; all others appear once.
  expect(instantiated).toBe(count + 1);
  const references = pages.reduce((total, page) => total + page.querySelectorAll("use").length, 0);
  // Only the first viewport adds one painted label and its opaque cover.
  expect(create.mock.calls.filter(([, name]) => name === "text")).toHaveLength(1);
  expect(create.mock.calls.filter(([, name]) => name === "rect")).toHaveLength(1);
  expect(create.mock.calls.length).toBe(3 * 4 + references + 2);
  expect(clone).not.toHaveBeenCalled();
  expect(imported).not.toHaveBeenCalled();
  expect(fixture.svg.querySelectorAll("path")).toHaveLength(count);
});

it("publishes one complete graphic when alternating long and short paths exceed the page reference limit", async () => {
  const output = await adversarialPage("alternating-overlap");
  expect(output.query.visits()).toBeGreaterThan(128);
  expect(output.query.visits()).toBeLessThanOrEqual(512);
  assertCompleteFallback(output);
});

it("bounds an empty query through interleaved distant paths and preserves ink with a complete fallback", async () => {
  const output = await adversarialPage("empty-interleaved");
  expect(output.query.visits()).toBe(512);
  assertCompleteFallback(output);
});

async function adversarialPage(pattern: "alternating-overlap" | "empty-interleaved") {
  const fixture = exportFragmentFixture([
    Array.from({ length: 2048 }, (_, index) => {
      const minY = pattern === "empty-interleaved" && index % 2 === 1 ? 100_000 : 0;
      const maxY = pattern === "alternating-overlap" && index % 2 === 0 ? 100_001 : minY + 1;
      return {
        markup: `<path d="M1 ${minY}L2 ${maxY}"/>`,
        minY,
        maxY,
        background: false,
      };
    }),
  ]);
  fixture.svg.setAttribute("viewBox", "0 0 1000 100100");
  const drawing = await prepareExportDrawing(fixture.svg, fixture.fragments, {
    scheduler: immediateWorkScheduler(),
    signal: new AbortController().signal,
  });
  const query = observeTreeQueries(drawing);
  const work = observeExportDomWork();
  const page = createExportPage(document, query.drawing, { start: 50_000, end: 50_100 });
  return { fixture, drawing, query, ...work, page };
}

function assertCompleteFallback(output: Awaited<ReturnType<typeof adversarialPage>>): void {
  expect(output.page.querySelectorAll("use")).toHaveLength(1);
  expect(output.page.querySelector("use")?.getAttribute("href")).toBe(`#${output.drawing.id}`);
  expect(resolveExportPagePaths(output.fixture.svg, output.page)).toEqual(output.fixture.paths);
  expect(output.create).toHaveBeenCalledTimes(5);
  expect(output.attributes.mock.calls.length).toBeLessThanOrEqual(18);
  expect(output.append).toHaveBeenCalledTimes(4);
  expect(output.clone).not.toHaveBeenCalled();
  expect(output.imported).not.toHaveBeenCalled();
  expect(output.fixture.svg.querySelectorAll("path")).toHaveLength(2048);
}

function observeExportDomWork() {
  return {
    create: vi.spyOn(document, "createElementNS"),
    attributes: vi.spyOn(window.Element.prototype, "setAttribute"),
    append: vi.spyOn(window.Element.prototype, "append"),
    clone: vi.spyOn(window.Node.prototype, "cloneNode"),
    imported: vi.spyOn(document, "importNode"),
  };
}

function observeTreeQueries(drawing: ExportDrawing) {
  let visits = 0;
  const observeRange = <T extends { readonly minY: number }>(range: T): T =>
    new Proxy(range, {
      get: (target, property, receiver) => {
        if (property === "minY") visits += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
  const observeTree = (tree: ExportFragmentTree): ExportFragmentTree =>
    observeRange({
      ...tree,
      children: tree.children.map(observeTree),
      entries: tree.entries.map(observeRange),
    });
  return {
    drawing: { ...drawing, fragments: drawing.fragments!.map(observeTree) },
    visits: () => visits,
  };
}
