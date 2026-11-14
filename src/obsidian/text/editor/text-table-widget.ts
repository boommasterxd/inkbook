import type { Text } from "@codemirror/state";
import type { EditorView, WidgetType } from "@codemirror/view";
import type { TextMarkdownBlock, TextSourceRange } from "../../../domain/text/text-types";
import type { TextMathWidgetPorts, TextTableRenderResult } from "./text-field-editor-types";
import { TextPreviewWidget } from "./text-preview-widget";
import {
  TextTableViewport,
  prepareTextTableViewport,
  type PreparedTextTableViewport,
} from "./text-table-viewport";
import { textTableSemanticsSteps } from "./text-table-semantics";
import { setTextTableSource } from "./text-table-mode";
import { textTableFollowingGap } from "../../../domain/text/text-layout-style";

const mountState = Symbol("inkbookTableMount");
interface TableNode extends HTMLElement {
  [mountState]?: TableMountState;
}
interface TableMountState {
  widget: TextTableWidget;
  readonly node: TableNode;
  readonly view: EditorView;
  readonly lifetime: AbortController;
  render: AbortController;
  pending?: AbortController;
  viewport?: TextTableViewport;
  result?: TextTableRenderResult;
  visual?: HTMLElement;
  rowTops?: readonly number[];
  editing?: { readonly range: TextSourceRange | undefined; readonly height: number | undefined };
}

/** The cell editor retains one DOM lifetime while source and row paint are replaced. */
export class TextTableWidget extends TextPreviewWidget {
  #prepared: { result: TextTableRenderResult; viewport?: PreparedTextTableViewport } | undefined;
  public constructor(
    readonly block: TextMarkdownBlock,
    readonly source: Text,
    readonly width: number,
    private readonly ports: TextMathWidgetPorts,
  ) {
    super();
  }

  public override eq(other: WidgetType): boolean {
    return (
      other instanceof TextTableWidget &&
      this.block === other.block &&
      this.source === other.source &&
      this.width === other.width
    );
  }

  public override toDOM(view: EditorView): HTMLElement {
    const node: TableNode = view.dom.ownerDocument.createElement("div");
    node.className = "inkbook-text-table-widget";
    this.#updateGap(node);
    const state: TableMountState = {
      widget: this,
      node,
      view,
      lifetime: new AbortController(),
      render: new AbortController(),
    };
    node[mountState] = state;
    this.#bindSourceActivation(state);
    this.#prepare(state);
    return node;
  }

  public override updateDOM(dom: HTMLElement, _view: EditorView): boolean {
    const state = (dom as TableNode)[mountState];
    if (!state || state.lifetime.signal.aborted) return false;
    state.widget = this;
    this.#updateGap(dom);
    this.#prepare(state);
    return true;
  }

  public override destroy(dom: HTMLElement): void {
    const node = dom as TableNode;
    const state = node[mountState];
    if (!state) return;
    state.lifetime.abort();
    state.render.abort();
    state.pending?.abort();
    state.widget.ports.tableEditing?.unmounted(node);
    delete node[mountState];
  }

  #updateGap(node: HTMLElement): void {
    node.setAttribute("data-inkbook-table-start", String(this.block.start));
    node.style.marginBottom = `${this.block.end < this.source.length ? textTableFollowingGap(this.ports.style().fontSize) : 0}px`;
  }

  #prepare(state: TableMountState): void {
    state.pending?.abort();
    const render = new AbortController();
    state.pending = render;
    const { node, lifetime } = state;
    lifetime.signal.addEventListener("abort", () => render.abort(), { signal: render.signal });
    if (this.#prepared) {
      const prepared = this.#prepared;
      this.#prepared = undefined;
      this.#commit(state, render, prepared);
      return;
    }
    const prepare = this.ports.renderTable;
    if (!prepare) return;
    node.setAttribute("aria-busy", "true");
    void prepare(this.block, render.signal, { availableWidth: this.width })
      .then((result) => this.#mount(state, render, result))
      .catch((error: unknown) => {
        if (render.signal.aborted) return;
        if (!state.result) node.append(this.#staticTable(node.ownerDocument, { from: 0, to: 1 }));
        this.#settled(state);
        this.ports.onError?.(error);
      });
  }

  async #mount(
    state: TableMountState,
    render: AbortController,
    result: TextTableRenderResult,
  ): Promise<void> {
    const signal = render.signal;
    if (signal.aborted) return;
    const viewport = result.renderRows
      ? await prepareTextTableViewport(this.#viewportOptions(state, result, signal))
      : undefined;
    if (signal.aborted) return;
    this.#commit(state, render, { result, ...(viewport ? { viewport } : {}) });
  }

  public async prepare(view: EditorView, signal: AbortSignal): Promise<void> {
    const result = await this.ports.renderTable?.(this.block, signal, {
      availableWidth: this.width,
    });
    if (!result) return;
    signal.throwIfAborted();
    const node =
      view.contentDOM.querySelector<HTMLElement>(
        `[data-inkbook-table-start="${this.block.start}"]`,
      ) ?? view.dom;
    const viewport = result.renderRows
      ? await prepareTextTableViewport(this.#viewportOptions({ node, view }, result, signal))
      : undefined;
    signal.throwIfAborted();
    this.#prepared = { result, ...(viewport ? { viewport } : {}) };
  }

  #viewportOptions(
    state: Pick<TableMountState, "node" | "view">,
    result: TextTableRenderResult,
    signal: AbortSignal,
  ) {
    const scheduler = this.ports.scheduler;
    if (!scheduler) throw new Error("Windowed table previews require the owned work scheduler.");
    return {
      view: state.view,
      node: state.node,
      result,
      signal,
      scheduler,
      source: this.source,
      block: this.block,
      width: this.width,
      label: this.ports.tableCellLabel ?? "Edit table cell",
      focusedRow: () => this.ports.tableEditing?.focusedRow(state.node),
      settled: () => undefined,
      onError: this.ports.onError,
    };
  }

  #commit(
    state: TableMountState,
    render: AbortController,
    prepared: { result: TextTableRenderResult; viewport?: PreparedTextTableViewport },
  ): void {
    const { node } = state;
    const { result } = prepared;
    state.render.abort();
    state.render = render;
    delete state.pending;
    this.#clearPresentation(state);
    state.result = result;
    const visual = node.ownerDocument.adoptNode(result.node);
    visual.setAttribute("aria-hidden", "true");
    visual.classList.add("inkbook-text-table-paint");
    state.visual = visual;
    node.prepend(visual);
    node.classList.add("inkbook-text-table-ready");
    if (result.renderRows) {
      const viewport = new TextTableViewport({
        ...this.#viewportOptions(state, result, render.signal),
        focusedRow: () => state.widget.ports.tableEditing?.focusedRow(node),
        settled: () => state.widget.#settled(state),
      });
      state.viewport = viewport;
      void viewport.start(prepared.viewport).catch((error: unknown) => this.ports.onError?.(error));
      this.#mounted(state, result);
      this.#settled(state);
    } else {
      const table = this.#staticTable(node.ownerDocument, {
        from: 0,
        to: this.block.table?.rows.length ?? 0,
      });
      const rowTops = [0];
      for (const [index, row] of [...table.rows].entries()) {
        const height = result.rowHeight?.(index) ?? result.rowHeights[index] ?? 0;
        row.style.height = `${height}px`;
        rowTops.push(rowTops[index]! + height);
      }
      state.rowTops = rowTops;
      node.append(table);
      this.#mounted(state, result);
      this.#settled(state);
    }
  }

  #mounted(state: TableMountState, result: TextTableRenderResult): void {
    this.ports.tableEditing?.mounted({
      node: state.node,
      view: state.view,
      block: this.block,
      source: this.source,
      width: this.width,
      rowHeights: result.rowHeights,
      signal: state.lifetime.signal,
      rowTop: (index) => state.viewport?.rowTop(index) ?? state.rowTops?.[index] ?? 0,
      refreshPaint: () => state.viewport?.refresh(),
      setEditingCell: (range, height) => {
        const previous = state.editing;
        if (
          previous &&
          previous.range?.start === range?.start &&
          previous.range?.end === range?.end &&
          previous.height === height
        )
          return;
        state.editing = { range, height };
        state.result?.setEditingCell?.(range, height);
        state.viewport?.refresh();
      },
    });
  }

  #clearPresentation(state: TableMountState): void {
    state.visual?.remove();
    delete state.visual;
    delete state.result;
    delete state.viewport;
    delete state.rowTops;
    delete state.editing;
    for (const child of [...state.node.children]) if (child.tagName === "TABLE") child.remove();
  }

  #settled(state: TableMountState): void {
    state.node.removeAttribute("aria-busy");
    state.view.requestMeasure();
    this.ports.invalidateBackground?.();
  }

  #staticTable(document: Document, range: { from: number; to: number }): HTMLTableElement {
    const steps = textTableSemanticsSteps(
      {
        document,
        block: this.block,
        source: this.source,
        label: this.ports.tableCellLabel ?? "Edit table cell",
      },
      range,
    );
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }

  #bindSourceActivation(state: TableMountState): void {
    const { node, view } = state;
    const activate = (event: Event) => {
      if (event.type === "click" && (event as MouseEvent).detail > 0) return;
      const target = (event.target as Element | null)?.closest<HTMLElement>(
        "button[data-inkbook-source]",
      );
      if (!target || !node.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      if ((event as MouseEvent).shiftKey) {
        view.dispatch({
          selection: {
            anchor: view.state.selection.main.anchor,
            head: Number(target.getAttribute("data-inkbook-source")),
          },
        });
        view.focus();
        return;
      }
      const editing = state.widget.ports.tableEditing;
      if (editing && state.result)
        editing.activate(
          node,
          Number(target.getAttribute("data-inkbook-table-row")),
          Number(target.getAttribute("data-inkbook-table-column")),
          event.type === "pointerdown"
            ? { x: (event as PointerEvent).clientX, y: (event as PointerEvent).clientY }
            : undefined,
        );
      else if (editing) {
        const block = state.widget.block;
        view.dispatch({
          selection: { anchor: Number(target.getAttribute("data-inkbook-source")) },
          effects: setTextTableSource.of({ start: block.start, end: block.end, source: true }),
        });
        view.focus();
      } else state.widget.ports.activate(view, Number(target.getAttribute("data-inkbook-source")));
    };
    const signal = state.lifetime.signal;
    node.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button === 0) activate(event);
      },
      { signal },
    );
    node.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter" || event.key === " ") activate(event);
      },
      { signal },
    );
    node.addEventListener("click", activate, { signal });
  }
}
