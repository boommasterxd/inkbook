import type { Extension, Transaction } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import type { TextMarkdownTableCell, TextSourceRange } from "../../../domain/text/text-types";
import { textTableEditSteps } from "../../../domain/text/text-table-edits";
import { textBlockBaseStyle } from "../../../domain/text/text-layout-style";
import type {
  TextTableEditorOptions,
  TextTableEditingPort,
  TextTableMount,
} from "./text-field-editor-types";
import { TextTableCellView } from "./text-table-cell-view";
import { TextTableControls, type TextTableUiAction } from "./text-table-controls";
import { TextTableHover } from "./text-table-hover";
import { setTextTableSource } from "./text-table-mode";
import { runTextEditorWork } from "./text-editor-work";
import { textTableCellTransaction } from "./text-table-cell-transaction";
import { tableCellAtPosition, tableEditTarget } from "./text-table-editing-position";
import { TextTableSourceMap } from "./text-table-source-map";
import {
  focusOutsideTextTable,
  tableCellNavigation,
  textTableArrowBindings,
  type TableCellDirection,
} from "./text-table-keyboard";

interface MountedTable {
  context: TextTableMount;
  controls: TextTableControls;
  readonly sourceMap: TextTableSourceMap;
}
interface ActiveCell {
  readonly table: MountedTable;
  readonly host: HTMLElement;
  readonly editor: TextTableCellView;
  row: number;
  column: number;
  start: number;
  end: number;
  height: number | undefined;
  geometry?: string;
  preview?: { readonly base: TextMarkdownTableCell; readonly cell: TextMarkdownTableCell };
}
interface PendingCell {
  readonly tableStart: number;
  readonly row: number;
  readonly column: number;
}
/** Only the outer editor owns source and history; one derived cell view owns native input. */
export class TextTableEditor {
  readonly #tables = new Map<HTMLElement, MountedTable>();
  readonly #hover = new TextTableHover();
  #active: ActiveCell | undefined;
  #pending: PendingCell | undefined;
  #pendingAction: { table: MountedTable; action: TextTableUiAction; column?: number } | undefined;
  #focusPosition: number | { x: number; y: number } | undefined;
  #forwarding = false;
  #disposed = false;
  #geometrySuspended = false;
  #operation = new AbortController();
  #refreshFrame: number | undefined;
  #changingTable: MountedTable | undefined;

  public constructor(private readonly options: TextTableEditorOptions) {}
  public readonly port: TextTableEditingPort = {
    mounted: (context) => this.#mounted(context),
    unmounted: (node) => this.#unmounted(node),
    activate: (node, row, column, point) => {
      const table = this.#tables.get(node);
      if (table) this.#activate(table, row, column, point);
    },
    focusedRow: (node) =>
      this.#active?.table.context.node === node ? this.#active.row : undefined,
  };

  public get inputView(): EditorView | undefined {
    return this.#active?.editor.view;
  }

  public arrowBindings(): Extension {
    return textTableArrowBindings(
      () => this.#tables.values(),
      (position) => this.focusAt(position),
    );
  }

  public intersects(range: TextSourceRange): boolean {
    for (const { context } of this.#tables.values())
      if (range.start < context.block.end && range.end > context.block.start) return true;
    return false;
  }

  #mounted(context: TextTableMount): void {
    if (this.#disposed || context.signal.aborted) return;
    let table = this.#tables.get(context.node);
    if (table) {
      if (!context.source.eq(context.view.state.doc)) return;
      table.context = context;
      table.sourceMap.reset(context.view.state.doc);
    } else {
      table = {
        context,
        controls: undefined as unknown as TextTableControls,
        sourceMap: new TextTableSourceMap(context.source),
      };
      const current = table;
      table.controls = new TextTableControls({
        hover: this.#hover,
        node: context.node,
        coordinates: this.options.options.surfaceCoordinates,
        view: context.view,
        signal: context.signal,
        ...(this.options.options.tableUi ? { ui: this.options.options.tableUi } : {}),
        onAction: (action) => this.#action(current, action),
        activeCell: () => (this.#active?.table === current ? this.#active : undefined),
        layout: () => current.context,
        shape: () => ({
          rows: current.context.block.table!.rows.length,
          columns: current.context.block.table!.alignments.length,
          alignments: current.context.block.table!.alignments,
        }),
      });
      this.#tables.set(context.node, table);
    }
    table.controls.refresh();
    table.controls.setSuspended(this.#geometrySuspended);
    if (!context.source.eq(context.view.state.doc)) return;
    if (this.#active?.table === table) this.#refreshActive();
    if (this.#pendingAction?.table === table) {
      const queued = this.#pendingAction;
      this.#pendingAction = undefined;
      this.#action(table, queued.action, queued.column);
      return;
    }
    const target = this.#pending;
    if (target?.tableStart === context.block.start) {
      if (target.row >= context.block.table!.rows.length) {
        this.#action(table, { kind: "append-row" });
        return;
      }
      this.#pending = undefined;
      this.#activate(table, target.row, target.column);
    } else if (this.#focusPosition !== undefined) this.focusAt(this.#focusPosition);
  }

  #unmounted(node: HTMLElement): void {
    const table = this.#tables.get(node);
    if (!table) return;
    if (this.#active?.table === table) this.#close(false);
    if (this.#pending?.tableStart === table.context.block.start) this.#pending = undefined;
    if (this.#pendingAction?.table === table) this.#pendingAction = undefined;
    table.controls.dispose();
    this.#tables.delete(node);
  }

  #activate(
    table: MountedTable,
    row: number,
    column: number,
    point?: number | { x: number; y: number },
  ): void {
    const { context } = table;
    const cell = table.sourceMap.cell(context, row, column);
    if (!cell) return;
    if (!table.sourceMap.matches(context.view.state.doc)) {
      this.#pending = { tableStart: context.block.start, row, column };
      return;
    }
    if (table.sourceMap.missing(context, row, cell)) {
      this.#materialize(table, row, column);
      return;
    }
    const position =
      typeof point === "number"
        ? Math.max(cell.contentStart, Math.min(cell.contentEnd, point))
        : cell.contentStart;
    const coordinates = typeof point === "number" ? undefined : point;
    if (
      this.#active?.table === table &&
      this.#active.row === row &&
      this.#active.column === column
    ) {
      if (typeof point === "number") {
        context.view.dispatch({ selection: { anchor: position } });
        this.#refreshActive();
      }
      this.#active.editor.focus(coordinates);
      return;
    }
    this.#close(false);
    this.#focusPosition = undefined;
    const host = context.node.ownerDocument.createElement("div");
    host.className = "inkbook-text-table-cell-overlay";
    host.setAttribute("data-inkbook-table-row", String(row));
    context.node.append(host);
    const editor = new TextTableCellView({
      host,
      editor: this.options.options,
      sourceOffset: () => this.#active?.start ?? cell.contentStart,
      originalPosition: this.options.originalPosition ?? ((position) => position),
      onTransaction: (transaction) => this.#transaction(transaction),
      onBeforeInput: () => this.#refreshActive(),
      onNavigate: (direction) => this.#navigate(direction),
      onStyle: (id, value) => this.options.applyStyle(id, value),
      onUndoRedo: this.options.undoRedo,
      onFinish: this.options.finish,
      onHeight: (height) => this.#height(height),
    });
    this.#active = {
      table,
      host,
      editor,
      row,
      column,
      start: cell.contentStart,
      end: cell.contentEnd,
      height: undefined,
    };
    context.node.classList.add("inkbook-text-table-editing");
    table.controls.refresh();
    context.view.dispatch({ selection: { anchor: position } });
    this.#refreshActive();
    editor.focus(coordinates);
    context.refreshPaint();
  }

  #materialize(table: MountedTable, row: number, column: number): void {
    const before = table.context.view.state.doc;
    this.#changingTable = table;
    try {
      table.context.view.dispatch({
        changes: table.sourceMap.materialize(table.context, row),
        userEvent: "input",
      });
    } finally {
      this.#changingTable = undefined;
    }
    if (table.context.view.state.doc !== before) this.#activate(table, row, column);
  }

  #transaction(transaction: Transaction): void {
    const active = this.#active;
    if (
      !active ||
      this.#forwarding ||
      this.#disposed ||
      (!transaction.docChanged && !transaction.selection)
    )
      return;
    this.#forwarding = true;
    try {
      active.table.context.view.dispatch(
        textTableCellTransaction(transaction, {
          view: active.table.context.view,
          block: active.table.context.block,
          start: active.start,
        }),
      );
    } catch (error) {
      this.options.options.onError?.(error);
    } finally {
      this.#forwarding = false;
    }
    this.#scheduleRefresh();
  }

  public update(update: ViewUpdate): void {
    if (this.#disposed) return;
    const active = this.#active;
    if (update.docChanged)
      (this.#changingTable ?? active?.table)?.sourceMap.record(update.changes, update.state.doc);
    if (active && update.docChanged) {
      active.start = update.changes.mapPos(active.start, -1);
      active.end = update.changes.mapPos(active.end, 1);
    }
    if (active && !this.#forwarding && update.selectionSet && !active.editor.view.hasFocus) {
      const range = update.state.selection.main;
      if (range.from < active.start || range.to > active.end) this.#close(false);
    }
    if (!this.#forwarding) this.#scheduleRefresh();
    if (update.selectionSet && this.#focusPosition !== update.state.selection.main.head)
      this.#focusPosition = undefined;
  }

  public refresh(): void {
    this.#scheduleRefresh();
  }

  public suspendGeometry(suspended: boolean): void {
    this.#geometrySuspended = suspended;
    for (const table of this.#tables.values()) table.controls.setSuspended(suspended);
  }

  #scheduleRefresh(): void {
    if (this.#disposed || !this.#active || this.#refreshFrame !== undefined) return;
    this.#refreshFrame = this.options.options.scheduler.requestFrame(() => {
      this.#refreshFrame = undefined;
      this.#refreshActive();
    }, "input");
  }

  #refreshActive(): void {
    const active = this.#active;
    if (!active || this.#forwarding || this.#disposed) return;
    const { context } = active.table;
    const { view, block, width } = context;
    const descriptor = block.table!;
    const cell = descriptor.rows[active.row]?.cells[active.column];
    const start = Math.min(view.state.doc.length, active.start);
    const end = Math.max(start, Math.min(view.state.doc.length, active.end));
    const columns = descriptor.alignments.length;
    const left = (width * active.column) / columns;
    const top = context.rowTop(active.row);
    const geometry = `${String(left)}:${String(top)}:${String(width / columns)}`;
    if (active.geometry !== geometry) {
      active.geometry = geometry;
      active.host.style.setProperty("left", `${String(left)}px`);
      active.host.style.setProperty("top", `${String(top)}px`);
      active.host.style.setProperty("width", `${String(width / columns)}px`);
    }
    const selection = view.state.selection.main;
    if (
      cell &&
      (active.preview?.base !== cell ||
        active.preview.cell.contentStart !== start ||
        active.preview.cell.contentEnd !== end)
    )
      active.preview = { base: cell, cell: { ...cell, contentStart: start, contentEnd: end } };
    active.editor.sync(
      view.state.doc.sliceString(start, end),
      {
        anchor: selection.anchor - start,
        head: selection.head - start,
      },
      {
        style: textBlockBaseStyle(this.options.style(), active.row === 0),
        width: width / columns,
        alignment: descriptor.alignments[active.column] ?? "left",
        ...(cell && context.source.eq(view.state.doc)
          ? {
              block,
              cell: active.preview!.cell,
              parentSource: this.options.source().source,
            }
          : {}),
      },
    );
    context.setEditingCell(
      cell ? { start: cell.contentStart, end: cell.contentEnd } : undefined,
      active.height,
    );
  }

  #height(height: number): void {
    const active = this.#active;
    if (!active || !Number.isFinite(height) || height <= 0 || active.height === height) return;
    active.height = height;
    const cell = active.table.context.block.table?.rows[active.row]?.cells[active.column];
    if (cell)
      active.table.context.setEditingCell(
        { start: cell.contentStart, end: cell.contentEnd },
        height,
      );
  }

  #navigate(direction: TableCellDirection): boolean {
    const active = this.#active;
    if (!active) return false;
    if (direction === "escape") {
      this.#close(true);
      return true;
    }
    const { table, row, column } = active;
    const shape = table.context.block.table!;
    const columns = shape.alignments.length;
    const pending =
      this.#pending?.tableStart === table.context.block.start ? this.#pending : undefined;
    const target = tableCellNavigation(pending ?? { row, column }, direction, {
      rows: shape.rows.length,
      columns,
    });
    if (pending && target.kind === "cell") {
      this.#pending = { tableStart: pending.tableStart, row: target.row, column: target.column };
      return true;
    }
    if (target.kind === "leave") {
      this.#close(false);
      focusOutsideTextTable(table, target.forward);
    } else if (target.kind === "append") this.#action(table, { kind: "append-row" }, target.column);
    else {
      const cell = table.sourceMap.cell(table.context, target.row, target.column);
      if (cell) this.focusAt(target.end ? cell.contentEnd : cell.contentStart);
    }
    return true;
  }

  #action(table: MountedTable, action: TextTableUiAction, targetColumn?: number): void {
    if (action.kind === "source") {
      const position = this.#active?.start ?? table.context.block.contentStart;
      this.#close(false);
      table.context.view.dispatch({
        effects: setTextTableSource.of({ ...table.context.block, source: true }),
        selection: { anchor: position },
      });
      table.context.view.focus();
      return;
    }
    this.#operation.abort();
    this.#operation = new AbortController();
    const { context } = table;
    const operation = this.#operation;
    const cancel = () => operation.abort();
    context.signal.addEventListener("abort", cancel, { once: true, signal: operation.signal });
    const document = context.view.state.doc;
    if (!context.source.eq(document)) {
      this.#pendingAction = {
        table,
        action,
        ...(targetColumn === undefined ? {} : { column: targetColumn }),
      };
      return;
    }
    const initialTarget = tableEditTarget(context.block, action, this.#active);
    const target =
      this.#pending?.tableStart === context.block.start
        ? this.#pending
        : initialTarget && targetColumn !== undefined
          ? { ...initialTarget, column: targetColumn }
          : initialTarget;
    const execute = () =>
      runTextEditorWork(
        textTableEditSteps(document.toString(), context.block, action),
        this.options.options.scheduler,
        operation.signal,
        (changes) => {
          if (context.signal.aborted || context.view.state.doc !== document) return;
          this.#close(false);
          this.#pending = target;
          context.view.dispatch({
            changes: changes.map((change) => ({
              from: change.start,
              to: change.end,
              insert: change.insert,
            })),
            userEvent: "input",
          });
          if (!target) context.view.focus();
        },
      );
    try {
      void execute()?.catch((error: unknown) => this.options.options.onError?.(error));
    } catch (error) {
      this.options.options.onError?.(error);
    }
  }

  public focusAt(position?: number | { x: number; y: number }): boolean {
    if (position === undefined) return false;
    this.#focusPosition = position;
    for (const table of this.#tables.values()) {
      if (!table.sourceMap.matches(table.context.view.state.doc)) continue;
      const target = tableCellAtPosition(
        table.context,
        typeof position === "number" ? table.sourceMap.originalPosition(position) : position,
      );
      if (!target) continue;
      this.#activate(table, target.row, target.column, position);
      return true;
    }
    return false;
  }

  public focus(): boolean {
    if (!this.#active) return false;
    this.#refreshActive();
    this.#active.editor.focus();
    return true;
  }

  #close(focus: boolean): void {
    const active = this.#active;
    if (!active) return;
    this.#active = undefined;
    active.editor.dispose();
    active.host.remove();
    active.table.context.node.classList.remove("inkbook-text-table-editing");
    active.table.controls.refresh();
    active.table.context.setEditingCell(undefined);
    if (focus && active.table.context.node.isConnected) active.table.context.view.focus();
  }

  public dispose(): void {
    this.#disposed = true;
    if (this.#refreshFrame !== undefined)
      this.options.options.scheduler.cancelFrame(this.#refreshFrame);
    this.#operation.abort();
    this.#close(false);
    for (const table of this.#tables.values()) table.controls.dispose();
    this.#tables.clear();
  }
}
