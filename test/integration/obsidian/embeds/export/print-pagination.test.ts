// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import { prepareExportDrawing } from "../../../../../src/obsidian/embeds/export/export-pages";
import {
  exportFragmentFixture,
  resolveExportPagePaths,
} from "../../../../fixtures/obsidian/export-fragment-tree";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { printPaginationFixture } from "../../../../fixtures/obsidian/print-pagination";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("uses current page room, avoids the prepared ink interval and restores exact native children", async () => {
  const fixture = await printPaginationFixture();
  const container = fixture.containers[0]!;
  const original = [...container.childNodes];
  const originalReferences = [...container.querySelectorAll("use")];
  const path = fixture.svg.querySelector("path");
  fixture.print(true);
  const pieces = container.querySelectorAll<HTMLElement>(".inkbook-export-piece");
  expect(pieces).toHaveLength(3);
  expect(pieces[0]?.classList.contains("inkbook-export-continued")).toBe(false);
  const firstCut = Number(pieces[0]?.dataset.inkbookRangeEnd);
  expect(firstCut).toBeLessThan(450);
  expect(firstCut).toBeGreaterThan(350);
  assertCompleteRanges(container, 1800, fixture.drawing.id);
  expect(fixture.svg.querySelector("path")).toBe(path);
  expect(fixture.layoutReads.every((read) => read.references === 0)).toBe(true);
  window.dispatchEvent(new Event("afterprint"));
  expect([...container.childNodes]).toEqual(original);
  expect([...container.querySelectorAll("use")]).toEqual(originalReferences);
  fixture.print(true);
  assertCompleteRanges(container, 1800, fixture.drawing.id);
  fixture.print(true);
  assertCompleteRanges(container, 1800, fixture.drawing.id);
  expect(fixture.layoutReads.every((read) => read.references === 0)).toBe(true);
  fixture.print(false);
  expect([...container.childNodes]).toEqual(original);
  expect([...container.querySelectorAll("use")]).toEqual(originalReferences);
  fixture.controller.dispose();
  expect(fixture.remove).toHaveBeenCalledOnce();
  expect(fixture.removeWindow).toHaveBeenCalledWith("afterprint", expect.any(Function));
  fixture.print(true);
  expect([...container.childNodes]).toEqual(original);
});

it("moves a nearly full-page drawing whole when little current space remains", async () => {
  const fixture = await printPaginationFixture({ height: 995, top: 900 });
  const container = fixture.containers[0]!;
  const original = [...container.childNodes];
  fixture.print(true);
  expect(container.dataset.inkbookPagination).toBe("keep");
  expect(container.classList.contains("inkbook-export-keep")).toBe(true);
  expect([...container.childNodes]).toEqual(original);
  fixture.print(false);
  expect([...container.childNodes]).toEqual(original);
  expect(container.classList.contains("inkbook-export-keep")).toBe(false);
  expect(container.dataset.inkbookPagination).toBeUndefined();
  fixture.controller.dispose();
});

it.each([
  { height: 995, expectedMargin: 0, expectedChildBreak: "auto" },
  { height: 500, expectedMargin: 15, expectedChildBreak: "page" },
])(
  "preserves native page capacity with a $height px graphic and a host margin",
  async ({ height, expectedMargin, expectedChildBreak }) => {
    const fixture = await printPaginationFixture({ height, top: 900, hostMargin: 15 });
    const host = fixture.hosts[0]!;
    const container = fixture.containers[0]!;
    const original = [...container.childNodes];
    const inlineStyle = host.getAttribute("style");
    try {
      expect(window.getComputedStyle(host).marginBlockStart).toBe("15px");
      fixture.print(true);
      expect(container.dataset.inkbookPagination).toBe("keep");
      expect(Number.parseFloat(window.getComputedStyle(host).marginBlockStart)).toBe(
        expectedMargin,
      );
      expect(window.getComputedStyle(container).breakBefore).toBe(expectedChildBreak);
      expect([...container.childNodes]).toEqual(original);
      window.dispatchEvent(new Event("afterprint"));
      expect(window.getComputedStyle(host).marginBlockStart).toBe("15px");
      expect(host.getAttribute("style")).toBe(inlineStyle);
      fixture.print(true);
      expect(Number.parseFloat(window.getComputedStyle(host).marginBlockStart)).toBe(
        expectedMargin,
      );
    } finally {
      fixture.controller.dispose();
    }
    expect(window.getComputedStyle(host).marginBlockStart).toBe("15px");
    expect(host.getAttribute("style")).toBe(inlineStyle);
  },
);

it.each([
  {
    name: "retains whole-page placement with padding-only overflow",
    height: 995,
    top: 900,
    bottom: 1995,
    keep: true,
  },
  {
    name: "restores whole graphics when trailing content overflows",
    height: 995,
    top: 900,
    bottom: 2010,
    keep: false,
  },
  {
    name: "restores split graphics when trailing content overflows",
    height: 1800,
    top: 100,
    bottom: 2010,
    keep: false,
  },
  {
    name: "restores graphics when the content end is unproven",
    height: 995,
    top: 900,
    bottom: NaN,
    keep: false,
  },
])("$name after native layout gains a page", async ({ height, top, bottom, keep }) => {
  const fixture = await printPaginationFixture({ height, top, nativeScale: 0.75, hostMargin: 15 });
  const container = fixture.containers[0]!;
  const original = [...container.childNodes];
  const references = [...container.querySelectorAll("use")];
  const tail = document.createElementNS("http://www.w3.org/1999/xhtml", "p");
  tail.textContent = "Trailing content must remain in the native PDF.";
  fixture.root.append(tail);
  const tailBounds = vi
    .spyOn(tail, "getBoundingClientRect")
    .mockReturnValue(DOMRect.fromRect({ y: bottom - 10, width: 1000, height: 10 }));
  const initial = [
    DOMRect.fromRect({ width: 1000, height: 1000 }),
    DOMRect.fromRect({ y: 1000, width: 1000, height: 995.7 }),
  ];
  const grown = [
    initial[0]!,
    DOMRect.fromRect({ y: 1000, width: 1000, height: 1000 }),
    DOMRect.fromRect({ y: 2000, width: 1000, height: 20 }),
  ];
  fixture.pages
    .mockReturnValueOnce(
      Object.assign(initial, { item: (index: number) => initial[index] ?? null }),
    )
    .mockReturnValue(Object.assign(grown, { item: (index: number) => grown[index] ?? null }));
  try {
    fixture.layoutReads.length = 0;
    fixture.print(true);
    expect(fixture.layoutReads.every((read) => read.references === 0)).toBe(true);
    expect(fixture.pages).toHaveBeenCalledTimes(2);
    expect(tailBounds).toHaveBeenCalledOnce();
    expect(container.dataset.inkbookPagination).toBe(keep ? "keep" : undefined);
    expect(Number.parseFloat(window.getComputedStyle(fixture.hosts[0]!).marginBlockStart)).toBe(
      keep ? 0 : 15,
    );
    expect([...container.childNodes]).toEqual(original);
    expect([...container.querySelectorAll("use")]).toEqual(references);
    expect(fixture.root.lastElementChild).toBe(tail);
    expect(fixture.root.classList.contains("inkbook-native-pdf-export")).toBe(true);
    fixture.print(false);
    expect([...container.childNodes]).toEqual(original);
    expect([...container.querySelectorAll("use")]).toEqual(references);
    expect(container.dataset.inkbookPagination).toBeUndefined();
    expect(window.getComputedStyle(fixture.hosts[0]!).marginBlockStart).toBe("15px");
  } finally {
    fixture.controller.dispose();
  }
});

it("starts a tall drawing on the next page when remaining room cannot hold a usable piece", async () => {
  const fixture = await printPaginationFixture({ top: 970 });
  const container = fixture.containers[0]!;
  fixture.print(true);
  const first = container.querySelector<HTMLElement>(".inkbook-export-piece");
  expect(first?.classList.contains("inkbook-export-continued")).toBe(true);
  expect(Number(first?.dataset.inkbookRangeEnd)).toBeLessThanOrEqual(965);
  assertCompleteRanges(container, 1800, fixture.drawing.id);
  fixture.controller.dispose();
  expect(container.querySelector(".inkbook-export-piece")).toBeNull();
});

it("retains continuous output when the renderer exposes no fragmented print-page coordinates", async () => {
  const fixture = await printPaginationFixture();
  const container = fixture.containers[0]!;
  const original = [...container.childNodes];
  const rectangle = DOMRect.fromRect({ width: 1000, height: 2500 });
  fixture.pages.mockReturnValue(
    Object.assign([rectangle], { item: (index: number) => (index === 0 ? rectangle : null) }),
  );
  fixture.print(true);
  expect([...container.childNodes]).toEqual(original);
  expect(container.querySelector(".inkbook-export-piece")).toBeNull();
  fixture.controller.dispose();
});

it.each([1, 0.75, 0.5])(
  "keeps the native root at its unscaled width while planning actual slices at scale %s",
  async (scale) => {
    const fixture = await nativePrintFixture(scale);
    const original = [...fixture.containers[0]!.childNodes];
    try {
      expect(fixture.root.getBoundingClientRect().width).toBe(1024);
      expect(fixture.root.classList.contains("inkbook-native-pdf-export")).toBe(scale < 1);
      fixture.print(true, () => {
        // Native page allocation sees the capped width before Inkbook's MQL callback runs.
        expect(fixture.root.getBoundingClientRect().width).toBe(721);
        expect(fixture.root.querySelector(".inkbook-export-piece")).toBeNull();
      });
      const pieces = fixture.containers[0]!.querySelectorAll<HTMLElement>(".inkbook-export-piece");
      expect(Number(pieces[0]!.dataset.inkbookRangeEnd)).toBeCloseTo(
        (1000 / scale - 500 - 23) / 0.657,
      );
      assertCompleteRanges(fixture.containers[0]!, 3600, fixture.drawing.id);
      expect(fixture.root.querySelector(".inkbook-export-viewport-probe")).toBeNull();
      window.dispatchEvent(new Event("afterprint"));
      expect([...fixture.containers[0]!.childNodes]).toEqual(original);
      expect(fixture.root.style.getPropertyValue("max-inline-size")).toBe("2000px");
      expect(fixture.root.style.getPropertyPriority("max-inline-size")).toBe("important");
      expect(fixture.root.classList.contains("inkbook-native-pdf-export")).toBe(false);
      fixture.print(false);
      window.dispatchEvent(new Event("beforeprint"));
      fixture.print(true, () => expect(fixture.root.getBoundingClientRect().width).toBe(721));
      assertCompleteRanges(fixture.containers[0]!, 3600, fixture.drawing.id);
    } finally {
      fixture.controller.dispose();
    }
  },
);

it("restores the complete graphic and original root style when native print validation fails", async () => {
  const fixture = await nativePrintFixture(0.75);
  const original = [...fixture.containers[0]!.childNodes];
  const references = [...fixture.containers[0]!.querySelectorAll("use")];
  fixture.styles.mockImplementationOnce(() => {
    throw new Error("Native layout validation failed after arming print-only sizing.");
  });
  try {
    fixture.print(true);
    expect([...fixture.containers[0]!.childNodes]).toEqual(original);
    expect([...fixture.containers[0]!.querySelectorAll("use")]).toEqual(references);
    expect(fixture.containers[0]!.querySelector(".inkbook-export-piece")).toBeNull();
    expect(fixture.root.classList.contains("inkbook-native-pdf-export")).toBe(true);
    window.dispatchEvent(new Event("afterprint"));
    expect(fixture.root.style.getPropertyValue("max-inline-size")).toBe("2000px");
    expect(fixture.root.style.getPropertyPriority("max-inline-size")).toBe("important");
    expect(fixture.root.querySelector(".inkbook-export-viewport-probe")).toBeNull();
  } finally {
    fixture.controller.dispose();
  }
});

it("scales complete fallback graphics without cut metadata and restores the root on disposal", async () => {
  const fixture = await nativePrintFixture(0.5, true);
  const references = [...fixture.containers[0]!.querySelectorAll("use")];
  fixture.print(true);
  expect(fixture.root.getBoundingClientRect().width).toBe(721);
  expect([...fixture.containers[0]!.querySelectorAll("use")]).toEqual(references);
  expect(fixture.containers[0]!.querySelector(".inkbook-export-piece")).toBeNull();
  expect(fixture.pages).not.toHaveBeenCalled();
  fixture.controller.dispose();
  expect(fixture.root.style.getPropertyValue("max-inline-size")).toBe("2000px");
  expect(fixture.root.style.getPropertyPriority("max-inline-size")).toBe("important");
});

it("retains complete output when a transformed native root has an unproven box model", async () => {
  const fixture = await nativePrintFixture(0.75);
  const original = [...fixture.containers[0]!.childNodes];
  Object.assign(fixture.root.style, { transform: "scale(2)" });
  try {
    fixture.print(true);
    expect([...fixture.containers[0]!.childNodes]).toEqual(original);
    expect(fixture.containers[0]!.querySelector("use")).not.toBeNull();
    expect(fixture.containers[0]!.querySelector(".inkbook-export-piece")).toBeNull();
    window.dispatchEvent(new Event("afterprint"));
    expect(fixture.root.style.getPropertyValue("max-inline-size")).toBe("2000px");
  } finally {
    fixture.controller.dispose();
  }
});

it("leaves a native root unchanged when its complete print maximum is unsupported", async () => {
  const fixture = await printPaginationFixture({ nativeScale: 0.75, deferStart: true });
  const keyword = "max-content";
  fixture.root.style.setProperty("max-inline-size", keyword);
  vi.spyOn(window.CSS, "supports").mockImplementation(
    (_property: string, value?: string) => !value?.startsWith(`min(${keyword},`),
  );
  const original = [...fixture.containers[0]!.childNodes];
  try {
    fixture.controller.start();
    fixture.print(true);
    expect([...fixture.containers[0]!.childNodes]).toEqual(original);
    expect(fixture.root.style.getPropertyValue("max-inline-size")).toBe(keyword);
    expect(fixture.root.classList.contains("inkbook-native-pdf-export")).toBe(false);
    expect(fixture.root.querySelector(".inkbook-export-piece")).toBeNull();
  } finally {
    fixture.controller.dispose();
  }
});

it("restores a complete occurrence after a layout failure and still paginates later occurrences", async () => {
  const fixture = await printPaginationFixture({ occurrences: 3 });
  const failed = fixture.containers[1]!;
  const original = [...failed.childNodes];
  const references = fixture.containers.map((container) => [...container.querySelectorAll("use")]);
  vi.spyOn(failed, "getBoundingClientRect").mockImplementation(() => {
    throw new Error("Print layout is temporarily unavailable.");
  });
  fixture.print(true);
  expect([...failed.childNodes]).toEqual(original);
  expect([...failed.querySelectorAll("use")]).toEqual(references[1]);
  expect(failed.dataset.inkbookPagination).toBe("fallback");
  assertCompleteRanges(fixture.containers[0]!, 1800, fixture.drawing.id);
  assertCompleteRanges(fixture.containers[2]!, 1800, fixture.drawing.id);
  expect(fixture.layoutReads.every((read) => read.references === 0)).toBe(true);
  fixture.controller.dispose();
  for (const [index, container] of fixture.containers.entries()) {
    expect([...container.querySelectorAll("use")]).toEqual(references[index]);
    expect(container.querySelector(".inkbook-export-piece")).toBeNull();
  }
});

it("converts two print pixels to drawing-space reference padding without expanding the page clip", async () => {
  const source = exportFragmentFixture([
    [
      { markup: '<path d="M1 100L2 101"/>', minY: 100, maxY: 101, background: false },
      { markup: '<path d="M1 957L2 957.2"/>', minY: 957, maxY: 957.2, background: false },
      { markup: '<path d="M1 959L2 959.2"/>', minY: 959, maxY: 959.2, background: false },
      { markup: '<path d="M1 3000L2 3001"/>', minY: 3000, maxY: 3001, background: false },
    ],
  ]);
  source.svg.setAttribute("viewBox", "0 0 1000 3600");
  const drawing = await prepareExportDrawing(source.svg, source.fragments, {
    scheduler: immediateWorkScheduler(),
    signal: new AbortController().signal,
  });
  const fixture = await printPaginationFixture({
    width: 500,
    height: 1800,
    preparedDrawing: { svg: source.svg, drawing, intervals: source.fragments },
  });
  const container = fixture.containers[0]!;
  const original = [...container.childNodes];
  fixture.print(true);
  const first = container.querySelector<HTMLElement>(".inkbook-export-piece");
  expect(first).not.toBeNull();
  expect(first!.dataset.inkbookRangeEnd).toBe("954");
  expect(first!.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 1000 954");
  const paths = resolveExportPagePaths(source.svg, first!);
  expect(paths).toHaveLength(2);
  expect(paths[0]).toBe(source.paths[0]);
  expect(paths[1]).toBe(source.paths[1]);
  expect(fixture.layoutReads.every((read) => read.references === 0)).toBe(true);
  fixture.controller.dispose();
  expect([...container.childNodes]).toEqual(original);
  expect(resolveExportPagePaths(source.svg, container)).toEqual(source.paths);
});

function assertCompleteRanges(container: HTMLElement, height: number, drawingId: string): void {
  let end = 0;
  const pieces = container.querySelectorAll<HTMLElement>(".inkbook-export-piece");
  expect(pieces.length).toBeGreaterThan(0);
  for (const piece of pieces) {
    const start = Number(piece.dataset.inkbookRangeStart);
    const next = Number(piece.dataset.inkbookRangeEnd);
    expect(start).toBe(end);
    expect(next).toBeGreaterThan(start);
    const graphic = piece.querySelector("svg[role='img']");
    expect(graphic?.getAttribute("viewBox")).toBe(`0 ${start} 1000 ${next - start}`);
    expect(graphic?.querySelector("use")?.getAttribute("href")).toBe(`#${drawingId}`);
    end = next;
  }
  expect(end).toBe(height);
}

async function nativePrintFixture(scale: number, withoutCuts = false) {
  const fixture = await printPaginationFixture({
    height: 3600,
    width: 657,
    nativeScale: scale,
    withoutCuts,
  });
  const { viewport } = fixture.nativeRoot!;
  const rectangles = Array.from({ length: 10 }, (_, index) =>
    DOMRect.fromRect({ y: (index * 1000) / scale, width: viewport + 1, height: 1000 / scale }),
  );
  fixture.pages.mockReturnValue(
    Object.assign(rectangles, { item: (index: number) => rectangles[index] ?? null }),
  );
  return fixture;
}
