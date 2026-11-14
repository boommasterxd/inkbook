import type { TextTableEdit } from "../../../domain/text/text-table-edits";

export interface TextTableTargetLayout {
  readonly width: number;
  readonly rows: number;
  readonly columns: number;
  readonly rowTop: (index: number) => number;
}

export interface TextTableTargetCell {
  readonly row: number;
  readonly column: number;
}

/** One runtime overlay identifies the operation's target without visiting mounted cells. */
export class TextTableTarget {
  readonly #svg: SVGSVGElement;
  readonly #outline: SVGRectElement;
  readonly #area: SVGRectElement;
  readonly #edge: SVGPathElement;
  #paint = "";

  public constructor(node: HTMLElement) {
    const document = node.ownerDocument;
    const namespace = "http://www.w3.org/2000/svg";
    this.#svg = document.createElementNS(namespace, "svg");
    this.#svg.classList.add("inkbook-text-table-target");
    this.#svg.setAttribute("aria-hidden", "true");
    this.#svg.setAttribute("hidden", "");
    this.#outline = document.createElementNS(namespace, "rect");
    this.#outline.setAttribute("fill", "none");
    this.#outline.setAttribute("stroke", "var(--text-normal, #222222)");
    this.#outline.setAttribute("stroke-width", "3.5");
    this.#outline.setAttribute("vector-effect", "non-scaling-stroke");
    this.#area = document.createElementNS(namespace, "rect");
    this.#edge = document.createElementNS(namespace, "path");
    this.#area.setAttribute("fill", "color-mix(in srgb, currentColor 12%, transparent)");
    this.#edge.setAttribute("fill", "none");
    for (const item of [this.#area, this.#edge]) {
      item.setAttribute("stroke", "currentColor");
      item.setAttribute("stroke-width", "1.5");
      item.setAttribute("vector-effect", "non-scaling-stroke");
    }
    this.#svg.append(this.#outline, this.#area, this.#edge);
    node.append(this.#svg);
  }

  public show(
    layout: TextTableTargetLayout,
    cell: TextTableTargetCell,
    action?: TextTableEdit,
  ): void {
    if (layout.rows < 1 || layout.columns < 1) return this.hide();
    const height = layout.rowTop(layout.rows);
    if (height <= 0 || layout.width <= 0) return this.hide();
    this.#showGeometry(layout, cell, action, height);
  }

  #showGeometry(
    layout: TextTableTargetLayout,
    cell: TextTableTargetCell,
    action: TextTableEdit | undefined,
    height: number,
  ): void {
    const row = Math.min(layout.rows - 1, Math.max(0, cell.row));
    const column = Math.min(layout.columns - 1, Math.max(0, cell.column));
    const columnWidth = layout.width / layout.columns;
    let x = column * columnWidth;
    let y = layout.rowTop(row);
    let width = columnWidth;
    let areaHeight = layout.rowTop(row + 1) - y;
    let edge = "";
    const rowAction = action && action.kind.includes("row");
    const columnAction = action && action.kind.includes("column");
    if (rowAction) {
      x = 0;
      width = layout.width;
      if (action.kind === "append-row" || action.kind === "insert-row") {
        const index =
          action.kind === "append-row"
            ? layout.rows
            : Math.max(1, action.row + (action.placement === "after" ? 1 : 0));
        edge = `M0 ${String(layout.rowTop(index))}H${String(layout.width)}`;
      }
    } else if (columnAction) {
      y = 0;
      areaHeight = height;
      if (action.kind === "insert-column")
        edge = `M${String(action.column * columnWidth)} 0V${String(height)}`;
    }
    const warning = action?.kind === "delete-row" || action?.kind === "delete-column";
    const paint = `${String(layout.width)}:${String(height)}:${String(x)}:${String(y)}:${String(width)}:${String(areaHeight)}:${edge}:${String(warning)}`;
    if (paint === this.#paint) return;
    this.#paint = paint;
    this.#svg.removeAttribute("hidden");
    this.#svg.setAttribute("data-warning", String(warning));
    this.#svg.setAttribute("width", String(layout.width));
    this.#svg.setAttribute("height", String(height));
    this.#svg.setAttribute(
      "data-inkbook-table-target",
      rowAction ? "row" : columnAction ? "column" : "cell",
    );
    for (const [name, value] of Object.entries({ x, y, width, height: areaHeight })) {
      this.#outline.setAttribute(name, String(value));
      this.#area.setAttribute(name, String(value));
    }
    this.#edge.setAttribute("d", edge);
  }

  public hide(): void {
    if (!this.#paint) return;
    this.#paint = "";
    this.#svg.setAttribute("hidden", "");
  }

  public dispose(): void {
    this.#svg.remove();
  }
}
