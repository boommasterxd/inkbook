import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { TextMarkdownBlock } from "../../../domain/text/text-types";
import type { TextTableRenderResult, TextTableRowRange } from "./text-field-editor-types";
import { runTextEditorWork } from "./text-editor-work";
import { textTableSemanticsSteps } from "./text-table-semantics";
import { visibleTextTableRows } from "./text-table-visible-rows";
import { TEXT_PREVIEW_VIEWPORT_EVENT } from "./text-preview-widget";

interface TextTableViewportOptions {
  readonly view: EditorView;
  readonly node: HTMLElement;
  readonly block: TextMarkdownBlock;
  readonly source: Text;
  readonly width: number;
  readonly label: string;
  readonly result: TextTableRenderResult;
  readonly scheduler: WorkScheduler;
  readonly signal: AbortSignal;
  readonly settled: () => void;
  readonly onError: ((error: unknown) => void) | undefined;
  readonly focusedRow?: (() => number | undefined) | undefined;
}

export interface PreparedTextTableViewport {
  readonly offsets: readonly number[];
  readonly range: TextTableRowRange;
  readonly table: HTMLTableElement;
  readonly focused: number | undefined;
}

/** Initial paint and semantic controls are complete before replacing the visible viewport. */
export async function prepareTextTableViewport(
  options: TextTableViewportOptions,
): Promise<PreparedTextTableViewport> {
  let offsets: readonly number[] = [];
  let table: HTMLTableElement | undefined;
  const { result, scheduler, signal, node, view, source, block, label, width } = options;
  if (result.rowHeights.length !== block.table?.rows.length)
    throw new TypeError("Table row geometry does not match its source.");
  const offsetsWork = runTextEditorWork(rowOffsetsSteps(result), scheduler, signal, (value) => {
    offsets = value;
  });
  if (offsetsWork) await offsetsWork;
  signal.throwIfAborted();
  const range = visibleTextTableRows(view, node, width, offsets);
  const focused = options.focusedRow?.();
  const semanticsWork = runTextEditorWork(
    textTableSemanticsSteps(
      {
        document: node.ownerDocument,
        block,
        source,
        label,
        offsets,
        focused,
      },
      range,
    ),
    scheduler,
    signal,
    (value) => {
      table = value;
    },
  );
  if (semanticsWork) await semanticsWork;
  await result.renderRows?.(range, signal);
  signal.throwIfAborted();
  return { offsets, range, table: table!, focused };
}

/** One native measurement owner windows both canonical paint and semantic source controls. */
export class TextTableViewport {
  #offsets: readonly number[] = [];
  #range: TextTableRowRange | undefined;
  #focused: number | undefined;
  #render = new AbortController();
  #geometry = new AbortController();
  #geometryVersion: number | undefined;
  #preparingGeometry = false;
  #started = false;
  #table: HTMLTableElement | undefined;

  public constructor(private readonly options: TextTableViewportOptions) {}

  public rowTop(index: number): number {
    return this.#offsets[index] ?? 0;
  }

  public async start(prepared?: PreparedTextTableViewport): Promise<void> {
    const { signal, result, node, view } = this.options;
    if (result.rowHeights.length !== this.options.block.table?.rows.length)
      throw new TypeError("Table row geometry does not match its source.");
    this.#started = true;
    signal.addEventListener(
      "abort",
      () => {
        this.#render.abort();
        this.#geometry.abort();
      },
      { once: true },
    );
    const update = () => this.#measure();
    view.dom.addEventListener(TEXT_PREVIEW_VIEWPORT_EVENT, update, { signal });
    const window = node.ownerDocument.defaultView;
    window?.addEventListener("scroll", update, { capture: true, signal });
    window?.addEventListener("resize", update, { signal });
    window?.visualViewport?.addEventListener("resize", update, { signal });
    window?.visualViewport?.addEventListener("scroll", update, { signal });
    if (prepared) {
      this.#offsets = prepared.offsets;
      this.#range = prepared.range;
      this.#table = prepared.table;
      this.#focused = prepared.focused;
      this.#geometryVersion = result.geometryVersion;
      node.style.height = `${prepared.offsets[prepared.offsets.length - 1] ?? 0}px`;
      node.append(prepared.table);
      this.#measure();
    } else await this.#prepareGeometry();
  }

  public refresh(): void {
    if (!this.#started || this.options.signal.aborted) return;
    if (this.#geometryVersion !== this.options.result.geometryVersion) {
      this.#render.abort();
      void this.#prepareGeometry().catch((error: unknown) => {
        if (!this.options.signal.aborted) this.options.onError?.(error);
      });
      return;
    }
    if (this.#preparingGeometry) return;
    this.#range = undefined;
    this.#measure();
  }

  async #prepareGeometry(): Promise<void> {
    this.#geometry.abort();
    const geometry = new AbortController();
    this.#geometry = geometry;
    const { scheduler, result, node, signal } = this.options;
    if (signal.aborted) return;
    this.#preparingGeometry = true;
    this.#geometryVersion = result.geometryVersion;
    await runTextEditorWork(rowOffsetsSteps(result), scheduler, geometry.signal, (offsets) => {
      this.#offsets = offsets;
      this.#range = undefined;
      node.style.height = `${offsets[offsets.length - 1] ?? 0}px`;
    });
    if (!signal.aborted && !geometry.signal.aborted) {
      this.#preparingGeometry = false;
      this.#measure();
    }
  }

  #measure(): void {
    const { view, node, width, signal } = this.options;
    if (signal.aborted || this.#preparingGeometry) return;
    view.requestMeasure({
      key: this,
      read: () =>
        signal.aborted || this.#preparingGeometry
          ? undefined
          : visibleTextTableRows(view, node, width, this.#offsets),
      write: (range) => {
        if (range && !signal.aborted) this.#refresh(range);
      },
    });
  }

  #refresh(range: TextTableRowRange): void {
    const { node, signal } = this.options;
    const active = node.ownerDocument.activeElement;
    const focused =
      active && node.contains(active) ? active.getAttribute("data-inkbook-table-row") : null;
    const row = this.options.focusedRow?.() ?? (focused === null ? undefined : Number(focused));
    if (this.#range?.from === range.from && this.#range.to === range.to && row === this.#focused)
      return;
    this.#range = range;
    this.#focused = row;
    this.#render.abort();
    const render = new AbortController();
    this.#render = render;
    void this.#publish(range, render.signal).catch((error: unknown) => {
      if (!signal.aborted && !render.signal.aborted) {
        this.options.settled();
        this.options.onError?.(error);
      }
    });
  }

  async #publish(range: TextTableRowRange, signal: AbortSignal): Promise<void> {
    const { view, node, source, block, scheduler, result, label } = this.options;
    let table: HTMLTableElement | undefined;
    await runTextEditorWork(
      textTableSemanticsSteps(
        {
          document: node.ownerDocument,
          block,
          source,
          label,
          offsets: this.#offsets,
          focused: this.#focused,
        },
        range,
      ),
      scheduler,
      signal,
      (prepared) => {
        table = prepared;
      },
    );
    if (signal.aborted || !table) return;
    await result.renderRows?.(range, signal);
    if (signal.aborted || this.options.signal.aborted) return;
    const focusedSource = node.ownerDocument.activeElement?.getAttribute("data-inkbook-source");
    this.#table?.remove();
    this.#table = table;
    node.append(table);
    if (focusedSource)
      table
        .querySelector<HTMLElement>(`button[data-inkbook-source="${focusedSource}"]`)
        ?.focus({ preventScroll: true });
    this.options.settled();
    view.requestMeasure();
  }
}

function* rowOffsetsSteps(result: TextTableRenderResult): Generator<void, readonly number[]> {
  const offsets = [0];
  for (let index = 0; index < result.rowHeights.length; index += 1) {
    const height = result.rowHeight?.(index) ?? result.rowHeights[index]!;
    if (!Number.isFinite(height) || height < 0) throw new TypeError("Invalid table row height.");
    offsets.push(offsets[offsets.length - 1]! + height);
    yield;
  }
  return offsets;
}
