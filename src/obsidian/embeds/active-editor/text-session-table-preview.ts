import type { TextElementV2 } from "../../../domain/schema/public";
import { canonicalizeGeometryNumber as canonical } from "../../../domain/schema/canonical";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { TextMarkdownBlock, TextSourceRange } from "../../../domain/text/text-types";
import type { PreparedTextTable } from "../../../rendering/text/text-layout-types";
import { MountedTextPresentation } from "../../../rendering/scene/content/mounted-text";
import { createInstrumentation } from "../../../rendering/scene/instrumentation";
import type {
  TextTableRenderResult,
  TextTableRowRange,
} from "../../text/editor/text-field-editor-types";

interface TableEditingCell {
  readonly range: TextSourceRange | undefined;
  readonly row: number;
  readonly delta: number;
}

/** Reuses the scene painter; scrolling publishes only the requested canonical rows. */
export function textSessionTablePreview(options: {
  readonly document: Document;
  readonly block: TextMarkdownBlock;
  readonly element: TextElementV2;
  readonly layout: PreparedTextTable;
  readonly scheduler: WorkScheduler;
}): TextTableRenderResult {
  const { document, layout, scheduler } = options;
  const node = document.createElement("span");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(layout.table.width));
  svg.setAttribute("height", String(layout.table.height));
  svg.setAttribute("viewBox", `0 0 ${layout.table.width} ${layout.table.height}`);
  node.append(svg);
  let editing: TableEditingCell = { range: undefined, row: -1, delta: 0 };
  let geometryVersion = 0;
  return {
    node,
    rowHeights: layout.table.rowHeights,
    rowHeight: (index) =>
      layout.table.rowHeights[index]! + (index === editing.row ? editing.delta : 0),
    get geometryVersion() {
      return geometryVersion;
    },
    setEditingCell: (range, height) => {
      const row = tableCellRow(options.block, range);
      const canonicalHeight = layout.table.rowHeights[row] ?? 0;
      const delta =
        row >= 0 && Number.isFinite(height) ? Math.max(0, (height ?? 0) - canonicalHeight) : 0;
      if (editing.delta !== delta || (delta > 0 && editing.row !== row)) geometryVersion += 1;
      editing = { range, row, delta };
      svg.setAttribute("height", String(layout.table.height + delta));
      svg.setAttribute("viewBox", `0 0 ${layout.table.width} ${layout.table.height + delta}`);
    },
    renderRows: async (range, signal) => {
      const element = tableRowElement(options, range, editing);
      const paint = new MountedTextPresentation(document, element, createInstrumentation(), true);
      try {
        while (!paint.prepare(element, 0, () => 0)) {
          const pending = scheduler.checkpoint(signal, "frame");
          if (pending !== undefined) await pending;
          signal.throwIfAborted();
        }
        signal.throwIfAborted();
        // The editing surface already owns the field background and its rounded outline.
        paint.group.firstElementChild?.remove();
        svg.replaceChildren(paint.group);
      } finally {
        paint.cancelPreparation();
      }
    },
  };
}

function tableRowElement(
  options: {
    readonly block: TextMarkdownBlock;
    readonly element: TextElementV2;
    readonly layout: PreparedTextTable;
  },
  range: TextTableRowRange,
  editing: TableEditingCell,
): TextElementV2 {
  const { element, layout, block } = options;
  const first = layout.rows[range.from];
  const last = layout.rows[range.to - 1];
  const followingRow = layout.rows[editing.row + 1];
  const followingSource = block.table?.rows[editing.row + 1]?.start;
  const lines =
    first && last
      ? layout.lines.slice(first.lineStart, last.lineEnd).map((line, index) => ({
          ...line,
          x: canonical(line.x - layout.table.x),
          y: canonical(
            line.y -
              layout.table.y +
              (followingRow && first.lineStart + index >= followingRow.lineStart
                ? editing.delta
                : 0),
          ),
          runs: editing.range
            ? line.runs.filter((run) => !insideCell(run, editing.range!))
            : line.runs,
        }))
      : [];
  const math =
    first && last
      ? layout.math
          .slice(first.mathStart, last.mathEnd)
          .map((item) => ({
            ...item,
            x: canonical(item.x - layout.table.x),
            y: canonical(
              item.y -
                layout.table.y +
                (followingSource !== undefined && item.start >= followingSource
                  ? editing.delta
                  : 0),
            ),
          }))
          .filter((item) => !editing.range || !insideCell(item, editing.range))
      : [];
  const runs = first && last ? block.runs.slice(first.runStart, last.runEnd) : [];
  const heights = layout.table.rowHeights
    .slice(range.from, range.to)
    .map((height, index) => height + (range.from + index === editing.row ? editing.delta : 0));
  // Row origins include cell padding, so use the accumulated frame heights for grid alignment.
  const rowTop = (first?.top ?? 0) + (range.from > editing.row ? editing.delta : 0);
  return {
    ...element,
    x: 0,
    y: 0,
    width: layout.table.width,
    height: layout.table.height + editing.delta,
    rotation: 0,
    pivot: { x: 0, y: 0 },
    ranges: runs.map((run) => ({ start: run.start, end: run.end, style: run.style })),
    layout: {
      version: 1,
      lines,
      math,
      tables: heights.length
        ? [
            {
              ...layout.table,
              x: 0,
              y: rowTop,
              height: canonical(heights.reduce((sum, n) => sum + n, 0)),
              rowHeights: heights,
            },
          ]
        : [],
    },
  };
}

function insideCell(item: TextSourceRange, cell: TextSourceRange): boolean {
  return item.start >= cell.start && item.end <= cell.end;
}

function tableCellRow(block: TextMarkdownBlock, range: TextSourceRange | undefined): number {
  if (!range) return -1;
  const rows = block.table?.rows ?? [];
  let from = 0;
  let to = rows.length;
  while (from < to) {
    const middle = Math.floor((from + to) / 2);
    const row = rows[middle]!;
    if (range.start < row.start) to = middle;
    else if (range.start > row.end) from = middle + 1;
    else return range.end <= row.end ? middle : -1;
  }
  return -1;
}
