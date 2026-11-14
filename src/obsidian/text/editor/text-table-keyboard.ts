import type { Extension } from "@codemirror/state";
import {
  cursorCharLeft,
  cursorCharRight,
  cursorLineDown,
  cursorLineUp,
} from "@codemirror/commands";
import { Direction, keymap, type EditorView } from "@codemirror/view";
import type { TextTableMount } from "./text-field-editor-types";
import type { TextTableSourceMap } from "./text-table-source-map";
import { tableNavigationIndex } from "./text-table-editing-position";

export type TableCellDirection =
  "next" | "previous" | "forward" | "backward" | "up" | "down" | "enter" | "escape";

interface KeyboardTable {
  readonly context: TextTableMount;
  readonly sourceMap: TextTableSourceMap;
}

/** Native movement runs once; only crossing a mounted preview transfers input to a cell. */
export function textTableArrowBindings(
  tables: () => Iterable<KeyboardTable>,
  activate: (position: number) => boolean,
): Extension {
  return keymap.of(
    [
      { key: "ArrowLeft", run: cursorCharLeft, forward: false, vertical: false },
      { key: "ArrowRight", run: cursorCharRight, forward: true, vertical: false },
      { key: "ArrowUp", run: cursorLineUp, forward: false, vertical: true },
      { key: "ArrowDown", run: cursorLineDown, forward: true, vertical: true },
    ].map(({ key, run, forward, vertical }) => ({
      key,
      run: (view: EditorView) => {
        const before = view.state.selection.main;
        if (view.state.selection.ranges.length !== 1 || !before.empty) return run(view);
        const x = vertical ? view.coordsAtPos(before.head)?.left : undefined;
        const logicalForward =
          vertical || view.textDirectionAt(before.head) === Direction.LTR ? forward : !forward;
        const moved = vertical
          ? view.moveVertically(before, forward)
          : view.moveByChar(before, logicalForward);
        const next =
          vertical && moved.head === before.head ? view.moveToLineBoundary(before, forward) : moved;
        const position = tableArrowEntry(tables(), {
          from: before.head,
          to: next.head,
          forward: logicalForward,
          x,
        });
        if (position !== undefined) activate(position);
        else if (!next.eq(before))
          view.dispatch({ selection: next, scrollIntoView: true, userEvent: "select" });
        return true;
      },
    })),
  );
}

function tableBounds(table: KeyboardTable) {
  const rows = table.context.block.table!.rows;
  const first = table.sourceMap.cell(table.context, 0, 0);
  const lastRow = rows.length - 1;
  const last = table.sourceMap.cell(table.context, lastRow, rows[lastRow]!.cells.length - 1);
  if (!first || !last) return undefined;
  const doc = table.context.view.state.doc;
  return { start: doc.lineAt(first.start).from, end: doc.lineAt(last.end).to };
}

function tableArrowEntry(
  tables: Iterable<KeyboardTable>,
  move: { from: number; to: number; forward: boolean; x: number | undefined },
): number | undefined {
  let result: { edge: number; position: number } | undefined;
  for (const table of tables) {
    if (!table.sourceMap.matches(table.context.view.state.doc)) continue;
    const bounds = tableBounds(table);
    if (!bounds) continue;
    const { from, to, forward, x } = move;
    if (Math.max(from, to) < bounds.start || Math.min(from, to) > bounds.end) continue;
    if (from === to && from === (forward ? bounds.end : bounds.start)) continue;
    const edge = forward ? bounds.start : bounds.end;
    if (result && (forward ? edge >= result.edge : edge <= result.edge)) continue;
    const position = entryCell(table, forward, x);
    if (position !== undefined) result = { edge, position };
  }
  return result?.position;
}

function entryCell(table: KeyboardTable, forward: boolean, x: number | undefined) {
  const grid = table.context.block.table!;
  const row = forward ? 0 : grid.rows.length - 1;
  const rect = x === undefined ? undefined : table.context.node.getBoundingClientRect();
  const column =
    x !== undefined && rect && rect.width > 0
      ? Math.max(
          0,
          Math.min(
            grid.alignments.length - 1,
            Math.floor(((x - rect.left) / rect.width) * grid.alignments.length),
          ),
        )
      : forward
        ? 0
        : grid.alignments.length - 1;
  const cell = table.sourceMap.cell(table.context, row, column);
  return cell && (forward ? cell.contentStart : cell.contentEnd);
}

/** Arrow boundaries leave the grid; only explicit Tab/Enter insertion grows it. */
export function tableCellNavigation(
  position: { row: number; column: number },
  direction: Exclude<TableCellDirection, "escape">,
  shape: { rows: number; columns: number },
) {
  const movement =
    direction === "forward"
      ? "next"
      : direction === "backward"
        ? "previous"
        : direction === "enter"
          ? "down"
          : direction;
  const index = tableNavigationIndex(position, movement, shape.columns);
  if (index < 0) return { kind: "leave", forward: false } as const;
  if (index >= shape.rows * shape.columns)
    return direction === "next" || direction === "enter"
      ? ({ kind: "append", column: direction === "next" ? 0 : position.column } as const)
      : ({ kind: "leave", forward: true } as const);
  return {
    kind: "cell",
    row: Math.floor(index / shape.columns),
    column: index % shape.columns,
    end: direction === "backward",
  } as const;
}

export function focusOutsideTextTable(table: KeyboardTable, forward: boolean): void {
  const bounds = tableBounds(table);
  if (!bounds) return;
  const view = table.context.view;
  const position = Math.max(
    0,
    Math.min(view.state.doc.length, forward ? bounds.end + 1 : bounds.start - 1),
  );
  view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
  view.focus();
}
