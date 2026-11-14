// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import {
  activateExportPage,
  createExportPage,
  prepareExportDrawing,
} from "../../../../../src/obsidian/embeds/export/export-pages";
import {
  exportFragmentFixture,
  resolveExportPagePaths,
} from "../../../../fixtures/obsidian/export-fragment-tree";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { PORTABLE_PALETTE_V1 } from "../../../../../src/domain/schema/public";

afterEach(() => vi.restoreAllMocks());

it("retains embedded font and local geometry resources across text continuation references", async () => {
  const fixture = exportFragmentFixture([
    [
      {
        markup:
          '<text x="20" y="220" font-family="inkbook-font-example"><tspan>Résumé</tspan></text>',
        minY: 200,
        maxY: 230,
        background: false,
      },
      { markup: '<path d="M1 5L2 10"/>', minY: 5, maxY: 10, background: false },
    ],
  ]);
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent =
    '@font-face{font-family:"inkbook-font-example";src:url(data:font/woff2;base64,d09GMg==)}';
  const definitions = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const geometry = document.createElementNS("http://www.w3.org/2000/svg", "path");
  geometry.id = "local-math-geometry";
  geometry.setAttribute("d", "M1 2L3 4");
  definitions.append(geometry);
  fixture.svg.prepend(style, definitions);
  const text = fixture.svg.querySelector("text")!;
  const drawing = await prepareExportDrawing(fixture.svg, fixture.fragments, {
    scheduler: immediateWorkScheduler(),
    signal: new AbortController().signal,
  });
  expect(drawing.fragments).toHaveLength(1);
  expect(fixture.svg.querySelector("defs > style")).toBe(style);
  expect(fixture.svg.querySelector("#local-math-geometry")).toBe(geometry);
  expect(fixture.svg.querySelector(`#${drawing.id} style`)).toBeNull();
  const page = createExportPage(document, drawing, { start: 190, end: 240 });
  const reference = page.querySelector("use")?.getAttribute("href");
  expect(reference).not.toBe(`#${drawing.id}`);
  const target = fixture.svg.querySelector(reference!);
  expect(target === text || target?.contains(text)).toBe(true);
  expect(target?.querySelectorAll("path")).toHaveLength(0);
  expect(text.textContent).toBe("Résumé");
  expect(text.getAttribute("font-family")).toBe("inkbook-font-example");
});

it("paints each occurrence's text once behind an opaque page, including legacy fallback graphics", async () => {
  const fixture = exportFragmentFixture([
    [{ markup: '<path d="M10 20L30 40"/>', minY: 20, maxY: 40, background: false }],
  ]);
  fixture.svg.setAttribute("viewBox", "0 0 1000 300");
  const drawing = await prepareExportDrawing(fixture.svg, undefined, {
    scheduler: immediateWorkScheduler(),
    signal: new AbortController().signal,
  });
  const cases = [
    { colorScheme: "light", description: "  Diagram <A> & B  " },
    { colorScheme: "dark", description: "Other" },
    { colorScheme: "light" },
  ] as const;
  for (const options of cases) {
    const container = createExportPage(document, drawing, options);
    const page = container.querySelector("svg")!;
    const [text, cover, reference] = [...page.children];
    expect(text?.localName).toBe("text");
    expect(text?.textContent).toBe(
      "description" in options ? options.description.trim() : "Handwriting",
    );
    expect(text?.children).toHaveLength(0);
    expect(cover?.localName).toBe("rect");
    expect(cover?.getAttribute("fill")).toBe(PORTABLE_PALETTE_V1[options.colorScheme].page);
    expect(cover?.getAttribute("opacity")).toBe("1");
    expect(["x", "y", "width", "height"].map((name) => cover?.getAttribute(name))).toEqual([
      "50",
      "37.5",
      "900",
      "225",
    ]);
    expect(reference?.localName).toBe("use");
    activateExportPage(container, drawing);
    expect(page.children).toHaveLength(3);
    expect(resolveExportPagePaths(fixture.svg, container)).toEqual(fixture.paths);
  }
});

it("defers text painting until activation and omits it from continuation pages", async () => {
  const fixture = exportFragmentFixture([
    [{ markup: '<path d="M10 20L30 140"/>', minY: 20, maxY: 140, background: false }],
  ]);
  const drawing = await prepareExportDrawing(fixture.svg, fixture.fragments, {
    scheduler: immediateWorkScheduler(),
    signal: new AbortController().signal,
  });
  for (const start of [0, 100]) {
    const container = createExportPage(document, drawing, {
      start,
      end: start + 100,
      description: "Diagram",
      deferGraphic: true,
    });
    const page = container.querySelector("svg")!;
    expect(page.children).toHaveLength(0);
    activateExportPage(container, drawing);
    expect(page.querySelectorAll("text")).toHaveLength(start === 0 ? 1 : 0);
    expect(page.querySelectorAll("rect")).toHaveLength(start === 0 ? 1 : 0);
    expect(page.querySelectorAll("use")).toHaveLength(1);
    expect(resolveExportPagePaths(fixture.svg, container)).toEqual(fixture.paths);
  }
});

it("selects ordered painted fragments for each page while preserving backgrounds and pressure groups", async () => {
  const fixture = exportFragmentFixture([
    [{ markup: '<path d="M0 0H1000V300H0Z"/>', minY: 0, maxY: 300, background: true }],
    [
      {
        markup: '<g opacity="0.35" transform="translate(4 120)"><path d="M0 0L10 20Z"/></g>',
        minY: 120,
        maxY: 140,
        background: false,
      },
    ],
    [
      { markup: '<path d="M10 5L20 20"/>', minY: 5, maxY: 20, background: false },
      { markup: '<path d="M10 95L20 205"/>', minY: 95, maxY: 205, background: false },
      { markup: '<path d="M10 220L20 250"/>', minY: 220, maxY: 250, background: false },
    ],
  ]);
  fixture.svg.setAttribute("viewBox", "0 0 1000 300");
  const pressure = fixture.paths[1]!.parentElement;
  const drawing = await prepareExportDrawing(fixture.svg, fixture.fragments, {
    scheduler: immediateWorkScheduler(),
    signal: new AbortController().signal,
  });
  const expectedIndices = [
    [0, 2, 3],
    [0, 1, 3],
    [0, 3, 4],
  ];
  for (const [index, expected] of expectedIndices.entries()) {
    const page = createExportPage(document, drawing, {
      start: index * 100,
      end: (index + 1) * 100,
    });
    expect(resolveExportPagePaths(fixture.svg, page)).toEqual(
      expected.map((path) => fixture.paths[path]),
    );
    expect(page.querySelector("use")?.getAttribute("href")).not.toBe(`#${drawing.id}`);
  }
  expect(fixture.paths[1]!.parentElement).toBe(pressure);
  expect(pressure?.getAttribute("opacity")).toBe("0.35");
  expect(pressure?.getAttribute("transform")).toBe("translate(4 120)");
  const full = createExportPage(document, drawing, {});
  expect(resolveExportPagePaths(fixture.svg, full)).toEqual(fixture.paths);
  expect(full.querySelectorAll("use")).toHaveLength(1);
});

it("retains nearby antialiased fragments only with reference padding while preserving the original clip", async () => {
  const fixture = exportFragmentFixture([
    [
      { markup: '<path d="M1 98L2 99"/>', minY: 98, maxY: 99, background: false },
      { markup: '<path d="M1 150L2 160"/>', minY: 150, maxY: 160, background: false },
      { markup: '<path d="M1 201L2 202"/>', minY: 201, maxY: 202, background: false },
      { markup: '<path d="M1 90L2 91"/>', minY: 90, maxY: 91, background: false },
      { markup: '<path d="M1 210L2 211"/>', minY: 210, maxY: 211, background: false },
    ],
  ]);
  const drawing = await prepareExportDrawing(fixture.svg, fixture.fragments, {
    scheduler: immediateWorkScheduler(),
    signal: new AbortController().signal,
  });
  const plain = createExportPage(document, drawing, { start: 100, end: 200 });
  expect(resolveExportPagePaths(fixture.svg, plain)).toEqual([fixture.paths[1]]);
  const padded = createExportPage(document, drawing, { start: 100, end: 200, deferGraphic: true });
  activateExportPage(padded, drawing, 2);
  const paths = resolveExportPagePaths(fixture.svg, padded);
  expect(paths).toHaveLength(3);
  for (const [index, path] of paths.entries()) expect(path).toBe(fixture.paths[index]);
  for (const page of [plain, padded]) {
    expect(page.querySelector("svg")?.getAttribute("viewBox")).toBe("0 100 1000 100");
    expect(page.querySelector("svg")?.getAttribute("height")).toBe("100");
  }
});

it("falls back to the complete graphic when geometry does not match the retained fragments", async () => {
  const fixture = exportFragmentFixture([
    [
      { markup: '<path d="M1 5L2 10"/>', minY: 5, maxY: 10, background: false },
      { markup: '<path d="M1 205L2 210"/>', minY: 205, maxY: 210, background: false },
    ],
  ]);
  const drawing = await prepareExportDrawing(fixture.svg, fixture.fragments.slice(1), {
    scheduler: immediateWorkScheduler(),
    signal: new AbortController().signal,
  });
  const page = createExportPage(document, drawing, { start: 0, end: 100 });
  expect(drawing.fragments).toBeUndefined();
  expect(page.querySelector("use")?.getAttribute("href")).toBe(`#${drawing.id}`);
  expect(resolveExportPagePaths(fixture.svg, page)).toEqual(fixture.paths);
});

it("stops fragment construction without further DOM writes after cancellation at a central checkpoint", async () => {
  const fixture = exportFragmentFixture([
    Array.from({ length: 100 }, (_, index) => ({
      markup: `<path d="M1 ${index}L2 ${index + 1}"/>`,
      minY: index,
      maxY: index + 1,
      background: false,
    })),
  ]);
  const controller = new AbortController();
  const create = vi.spyOn(document, "createElementNS");
  const attributes = vi.spyOn(window.Element.prototype, "setAttribute");
  const append = vi.spyOn(window.Element.prototype, "append");
  let release!: () => void;
  const checkpoint = vi.fn(() =>
    checkpoint.mock.calls.length === 16
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : undefined,
  );
  const pending = prepareExportDrawing(fixture.svg, fixture.fragments, {
    scheduler: { ...immediateWorkScheduler(), checkpoint },
    signal: controller.signal,
  });
  expect(checkpoint).toHaveBeenCalledTimes(16);
  expect(checkpoint).toHaveBeenLastCalledWith(controller.signal, "background");
  expect(fixture.paths.filter((path) => path.hasAttribute("id"))).toHaveLength(16);
  const writes = {
    create: create.mock.calls.length,
    attributes: attributes.mock.calls.length,
    append: append.mock.calls.length,
  };
  controller.abort();
  release();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(create).toHaveBeenCalledTimes(writes.create);
  expect(attributes).toHaveBeenCalledTimes(writes.attributes);
  expect(append).toHaveBeenCalledTimes(writes.append);
  expect(create.mock.results.every((result) => !(result.value as Element).isConnected)).toBe(true);
});
