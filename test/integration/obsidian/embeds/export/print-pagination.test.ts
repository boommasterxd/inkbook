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

it("moves a whole drawing when it fits the next page and little current space remains", async () => {
  const fixture = await printPaginationFixture({ height: 500, top: 900 });
  const container = fixture.containers[0]!;
  const original = [...container.childNodes];
  fixture.print(true);
  expect(container.dataset.inkbookPagination).toBe("keep");
  expect(container.classList.contains("inkbook-export-keep")).toBe(true);
  expect([...container.childNodes]).toEqual(original);
  fixture.print(false);
  expect(container.classList.contains("inkbook-export-keep")).toBe(false);
  expect(container.dataset.inkbookPagination).toBeUndefined();
  fixture.controller.dispose();
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
