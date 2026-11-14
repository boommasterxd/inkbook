// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { textTableGridPathSteps } from "../../../../../src/domain/geometry/text-table-grid-path";
import { finishGeometrySteps } from "../../../../fixtures/domain/geometry-steps";
import { canonicalizeGeometryNumber } from "../../../../../src/domain/schema/canonical";
import type { TextMarkdownBlock } from "../../../../../src/domain/text/text-types";
import { textSessionTablePreview } from "../../../../../src/obsidian/embeds/active-editor/text-session-table-preview";
import { layoutTextMarkdown } from "../../../../../src/rendering/text/text-layout";
import type { PreparedTextTable } from "../../../../../src/rendering/text/text-layout-types";
import { parseTextMarkdown } from "../../../../fixtures/domain/text-source";
import { createTestWorkScheduler } from "../../../../fixtures/persistence/work-scheduler";
import { textElement } from "../../../../fixtures/rendering/text";

const fontResourceId = "a".repeat(64);
const mathPath = "M0 0L20 20Z";

async function fixture() {
  const source = `before\n\n| Name | Value |\n| --- | --- |\n${Array.from(
    { length: 40 },
    (_, index) => `| long wrapped row ${index} | $x$ |`,
  ).join("\n")}`;
  const start = source.indexOf("long wrapped");
  const element = textElement({
    source,
    width: 220,
    ranges: [
      {
        start,
        end: source.length,
        style: {
          color: { type: "rgba", value: "#123456FF" },
          opacity: 0.25,
          backgroundColor: { type: "rgba", value: "#AABBCCFF" },
          backgroundOpacity: 0.4,
        },
      },
    ],
  });
  const parsed = parseTextMarkdown(source, { style: element.style, ranges: element.ranges });
  let prepared: { block: TextMarkdownBlock; layout: PreparedTextTable } | undefined;
  const scheduler = createTestWorkScheduler();
  await layoutTextMarkdown(
    { document: parsed, width: element.width, style: element.style, padding: 10 },
    {
      scheduler,
      measure: {
        measure: (text, style) => ({
          width: text.length * style.fontSize * 0.5,
          ascent: style.fontSize * 0.8,
          descent: style.fontSize * 0.2,
          fontResourceId,
        }),
      },
      math: {
        resolve: async () => ({
          width: 20,
          height: 20,
          ascent: 15,
          descent: 5,
          paths: [{ d: mathPath }],
        }),
      },
      onTablePrepared: (block, layout) => {
        prepared = { block, layout };
      },
    },
  );
  if (!prepared) throw new Error("Missing prepared table.");
  const options = { ...prepared, document, element, scheduler };
  return { ...options, preview: textSessionTablePreview(options) };
}

function observeItems<T>(items: readonly T[]) {
  const reads = new Set<number>();
  for (const [index, item] of items.entries()) {
    Object.defineProperty(items, index, {
      configurable: true,
      get: () => {
        reads.add(index);
        return item;
      },
    });
  }
  return reads;
}

describe("canonical windowed table preview", () => {
  it("paints wrapped source, fonts, math and backgrounds at table-local row coordinates", async () => {
    const { preview, layout } = await fixture();
    const first = layout.rows[1]!;
    const last = layout.rows[3]!;
    const lines = layout.lines.slice(first.lineStart, last.lineEnd);
    const runs = lines.flatMap((line) => line.runs);
    expect(lines.length).toBeGreaterThan(6);
    expect(layout.table.y).toBeGreaterThan(10);
    await preview.renderRows!({ from: 1, to: 4 }, new AbortController().signal);
    const spans = [...preview.node.querySelectorAll("tspan")];
    expect(spans.map((span) => span.textContent)).toEqual(runs.map((run) => run.text));
    expect(
      spans.every((span) => span.getAttribute("font-family") === `inkbook-face-${fontResourceId}`),
    ).toBe(true);
    expect(spans[0]?.getAttribute("x")).toBe(String(lines[0]!.x - layout.table.x + runs[0]!.x));
    expect(spans[0]?.getAttribute("y")).toBe(
      String(canonicalizeGeometryNumber(lines[0]!.y - layout.table.y) + lines[0]!.baseline),
    );
    const paths = [...preview.node.querySelectorAll("path")];
    expect(paths.filter((path) => path.getAttribute("d") === mathPath)).toHaveLength(3);
    expect(
      paths.find((path) => path.getAttribute("fill") === "#AABBCCFF")?.getAttribute("fill-opacity"),
    ).toBe("0.4");
    const math = paths.find((path) => path.getAttribute("d") === mathPath)!;
    expect(math.parentElement?.getAttribute("fill")).toBe("#123456FF");
    expect(math.parentElement?.getAttribute("fill-opacity")).toBe("0.25");
    const heights = layout.table.rowHeights.slice(1, 4);
    const gridFrame = {
      ...layout.table,
      x: 0,
      y: first.top,
      height: canonicalizeGeometryNumber(heights.reduce((sum, height) => sum + height, 0)),
      rowHeights: heights,
    };
    const grid = finishGeometrySteps(textTableGridPathSteps(gridFrame));
    expect(paths.some((path) => path.getAttribute("d") === grid)).toBe(true);
    expect(preview.rowHeights).toBe(layout.table.rowHeights);
    expect(preview.node.querySelector("svg")?.getAttribute("height")).toBe(
      String(layout.table.height),
    );
  });
  it("reads only requested row content while replacing initial, far-scrolled and empty paint", async () => {
    const { preview, layout, block } = await fixture();
    const lines = observeItems(layout.lines);
    const math = observeItems(layout.math);
    const runs = observeItems(block.runs);
    const node = preview.node;
    for (const range of [
      { from: 0, to: 2 },
      { from: 35, to: 38 },
    ]) {
      lines.clear();
      math.clear();
      runs.clear();
      await preview.renderRows!(range, new AbortController().signal);
      const first = layout.rows[range.from]!;
      const last = layout.rows[range.to - 1]!;
      for (const [reads, start, end] of [
        [lines, first.lineStart, last.lineEnd],
        [math, first.mathStart, last.mathEnd],
        [runs, first.runStart, last.runEnd],
      ] as const) {
        expect([...reads]).toEqual(
          Array.from({ length: end - start }, (_, index) => start + index),
        );
      }
      expect(preview.node).toBe(node);
      expect(node.querySelectorAll("tspan").length).toBeLessThan(30);
      expect(node.querySelectorAll(`path[d="${mathPath}"]`).length).toBeLessThanOrEqual(3);
    }
    await preview.renderRows!({ from: 0, to: 0 }, new AbortController().signal);
    expect(node.querySelectorAll("tspan, path")).toHaveLength(0);
  });

  it("keeps prior paint when cooperative preparation is aborted before publication", async () => {
    const options = await fixture();
    const abort = new AbortController();
    let supersede = false;
    const checkpoint = vi.fn(() => {
      if (supersede) abort.abort(new Error("Table scroll superseded."));
      return Promise.resolve();
    });
    const preview = textSessionTablePreview({
      ...options,
      scheduler: createTestWorkScheduler({ checkpoint }),
    });
    await preview.renderRows!({ from: 0, to: 1 }, new AbortController().signal);
    const prior = preview.node.querySelector("svg")!.firstElementChild;
    const priorText = preview.node.textContent;
    checkpoint.mockClear();
    supersede = true;
    await expect(preview.renderRows!({ from: 35, to: 38 }, abort.signal)).rejects.toThrow(
      "Table scroll superseded.",
    );
    expect(checkpoint).toHaveBeenCalled();
    expect(preview.node.querySelector("svg")!.firstElementChild).toBe(prior);
    expect(preview.node.textContent).toBe(priorText);
  });
});

describe("active cell preview paint", () => {
  it("excludes only the edited cell while retaining the shared grid and restores its paint", async () => {
    const { preview, block, layout } = await fixture();
    const range = { from: 1, to: 3 };
    await preview.renderRows!(range, new AbortController().signal);
    const prior = preview.node.textContent;
    const heights = layout.table.rowHeights.slice(range.from, range.to);
    const grid = finishGeometrySteps(
      textTableGridPathSteps({
        ...layout.table,
        x: 0,
        y: layout.rows[range.from]!.top,
        height: canonicalizeGeometryNumber(heights.reduce((sum, height) => sum + height, 0)),
        rowHeights: heights,
      }),
    );
    const textCell = block.table!.rows[1]!.cells[0]!;
    preview.setEditingCell?.({ start: textCell.contentStart, end: textCell.contentEnd });
    await preview.renderRows!(range, new AbortController().signal);
    expect(preview.node.textContent).not.toContain("long wrapped row 0");
    expect(preview.node.textContent).toContain("long wrapped row 1");
    expect(preview.node.querySelector(`path[d="${grid}"]`)).not.toBeNull();
    const mathCell = block.table!.rows[1]!.cells[1]!;
    preview.setEditingCell?.({ start: mathCell.contentStart, end: mathCell.contentEnd });
    await preview.renderRows!(range, new AbortController().signal);
    expect(preview.node.querySelectorAll(`path[d="${mathPath}"]`)).toHaveLength(1);
    expect(preview.node.textContent).toBe(prior);
    preview.setEditingCell?.(undefined);
    await preview.renderRows!(range, new AbortController().signal);
    expect(preview.node.querySelectorAll(`path[d="${mathPath}"]`)).toHaveLength(2);
    expect(preview.node.textContent).toBe(prior);
  });
});

describe("temporary table editor row geometry", () => {
  it("expands only the active row, shifts following text and math, and restores canonical geometry", async () => {
    const { preview, block, layout } = await fixture();
    const cell = block.table!.rows[1]!.cells[0]!;
    const range = { start: cell.contentStart, end: cell.contentEnd };
    const canonicalHeight = layout.table.rowHeights[1]!;
    const originalHeights = [...layout.table.rowHeights];
    const line = layout.lines[layout.rows[2]!.lineStart]!;
    const expectedY = canonicalizeGeometryNumber(line.y - layout.table.y + 50) + line.baseline;
    const firstMath = layout.math[layout.rows[1]!.mathStart]!;
    const lastMath = layout.math[layout.rows[2]!.mathStart]!;
    preview.setEditingCell?.(range, canonicalHeight + 50);
    const version = preview.geometryVersion;
    expect(preview.rowHeight?.(1)).toBe(canonicalHeight + 50);
    expect(preview.rowHeight?.(2)).toBe(layout.table.rowHeights[2]);
    preview.setEditingCell?.(range, canonicalHeight + 50);
    expect(preview.geometryVersion).toBe(version);
    await preview.renderRows!({ from: 1, to: 3 }, new AbortController().signal);
    expect(preview.node.querySelector("tspan")?.getAttribute("y")).toBe(String(expectedY));
    const math = [...preview.node.querySelectorAll(`path[d="${mathPath}"]`)];
    expect(math[0]?.parentElement?.getAttribute("transform")).toBe(
      `translate(${firstMath.x - layout.table.x} ${canonicalizeGeometryNumber(firstMath.y - layout.table.y)})`,
    );
    expect(math[1]?.parentElement?.getAttribute("transform")).toBe(
      `translate(${lastMath.x - layout.table.x} ${canonicalizeGeometryNumber(lastMath.y - layout.table.y + 50)})`,
    );
    expect(preview.node.querySelector("svg")?.getAttribute("height")).toBe(
      String(layout.table.height + 50),
    );
    const heights = [canonicalHeight + 50, layout.table.rowHeights[2]!];
    const grid = finishGeometrySteps(
      textTableGridPathSteps({
        ...layout.table,
        x: 0,
        y: layout.rows[1]!.top,
        height: canonicalizeGeometryNumber(heights.reduce((sum, height) => sum + height, 0)),
        rowHeights: heights,
      }),
    );
    expect(preview.node.querySelector(`path[d="${grid}"]`)).not.toBeNull();
    await preview.renderRows!({ from: 2, to: 3 }, new AbortController().signal);
    expect(preview.node.querySelector("tspan")?.getAttribute("y")).toBe(String(expectedY));
    const followingGrid = finishGeometrySteps(
      textTableGridPathSteps({
        ...layout.table,
        x: 0,
        y: layout.rows[2]!.top + 50,
        height: layout.table.rowHeights[2]!,
        rowHeights: [layout.table.rowHeights[2]!],
      }),
    );
    expect(preview.node.querySelector(`path[d="${followingGrid}"]`)).not.toBeNull();
    preview.setEditingCell?.(undefined);
    expect(preview.rowHeight?.(1)).toBe(canonicalHeight);
    expect(layout.table.rowHeights).toEqual(originalHeights);
    expect(preview.node.querySelector("svg")?.getAttribute("height")).toBe(
      String(layout.table.height),
    );
  });
});
