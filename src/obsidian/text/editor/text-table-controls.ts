import { setIcon } from "obsidian";
import type { EditorView } from "@codemirror/view";
import type { TextTableEdit } from "../../../domain/text/text-table-edits";
import { effectiveTransitionDuration } from "../../runtime/effective-motion";
import { observeMenuMotionPreference, playMenuMotion } from "../../menus/feedback/menu-motion";
import { TEXT_PREVIEW_VIEWPORT_EVENT } from "./text-preview-widget";
import { textTableControlPositions, type TableControlBounds } from "./text-table-control-position";
import { TextTableTarget, type TextTableTargetCell } from "./text-table-target";
import { TextTableHover, type TextTableHoverTarget } from "./text-table-hover";
import type { TextEditingCoordinates } from "../../../rendering/scene/text-editing-geometry";

export type TextTableUiAction = TextTableEdit | { readonly kind: "source" };
type TableAlignment = Extract<TextTableEdit, { kind: "align-column" }>["alignment"];

export interface TextTableUiPort {
  readonly labels: Readonly<
    Record<"addRow" | "addColumn" | "menu" | "source" | "preview" | "cell", string>
  >;
  openMenu(request: {
    readonly anchor: HTMLElement;
    readonly row: number;
    readonly column: number;
    readonly rows: number;
    readonly columns: number;
    readonly alignment?: TableAlignment | undefined;
    readonly signal: AbortSignal;
    readonly onAction: (action: TextTableUiAction) => void;
    readonly onPreview?: (action: TextTableUiAction | undefined) => void;
    readonly onClose: () => void;
  }): void;
}

interface TableControlsOptions {
  readonly view: EditorView;
  readonly node: HTMLElement;
  readonly coordinates?: TextEditingCoordinates | undefined;
  readonly hover?: TextTableHover;
  readonly signal: AbortSignal;
  readonly ui?: TextTableUiPort;
  readonly onAction: (action: TextTableUiAction) => void;
  readonly activeCell: () => { readonly row: number; readonly column: number } | undefined;
  readonly layout?: () => { readonly width: number; readonly rowTop: (index: number) => number };
  readonly shape: () => {
    readonly rows: number;
    readonly columns: number;
    readonly alignment?: TableAlignment;
    readonly alignments?: readonly TableAlignment[];
  };
}

/** One bounded set of controls belongs to the table, independent of recycled rows. */
export class TextTableControls {
  readonly #lifetime = new AbortController();
  readonly #root: HTMLElement;
  readonly #layer: HTMLElement;
  readonly #buttons: HTMLButtonElement[] = [];
  readonly #target: TextTableTarget;
  readonly #hover: TextTableHover;
  readonly #hoverTarget: TextTableHoverTarget;
  #hoverBounds: TableControlBounds | undefined;
  #lastCell: TextTableTargetCell = { row: 0, column: 0 };
  #menuCell: TextTableTargetCell | undefined;
  #preview: TextTableUiAction | undefined;
  #hovered = false;
  #menuOpen = false;
  #visible = false;
  #stopMotion: (() => void) | undefined;
  #releasePreference: (() => void) | undefined;
  #measurePending = false;
  #suspended = false;

  public constructor(private readonly options: TableControlsOptions) {
    this.#target = new TextTableTarget(options.node);
    const drawingDocument = options.coordinates?.drawingDocument ?? options.node.ownerDocument;
    this.#root = drawingDocument.createElement("div");
    this.#root.className = "inkbook-text-table-controls inkbook-text-table-controls-hidden";
    this.#root.contentEditable = "false";
    this.#layer = drawingDocument.createElement("div");
    this.#layer.className = `cm-editor ${options.view.themeClasses} inkbook-text-table-controls-layer`;
    this.#layer.append(this.#root);
    this.#hover = options.hover ?? new TextTableHover();
    this.#hoverTarget = {
      node: options.node,
      layer: this.#layer,
      coordinates: options.coordinates,
      bounds: () => this.#hoverBounds,
      changed: (hovered) => {
        this.#hovered = hovered;
        this.#updateVisibility();
      },
    };
    const labels = options.ui?.labels;
    this.#addButton("add-row", "plus", labels?.addRow ?? "Add row", () =>
      options.onAction({ kind: "append-row" }),
    );
    this.#addButton("add-column", "plus", labels?.addColumn ?? "Add column", () =>
      options.onAction({ kind: "insert-column", column: options.shape().columns }),
    );
    const menu = this.#addButton("menu", "ellipsis", labels?.menu ?? "Table options", (anchor) =>
      this.#openMenu(anchor),
    );
    menu.setAttribute("aria-haspopup", "menu");
    menu.setAttribute("aria-expanded", "false");
    drawingDocument.body.append(this.#layer);
    this.#bindVisibility();
    this.#bindPlacement();
    options.signal.addEventListener("abort", () => this.dispose(), {
      signal: this.#lifetime.signal,
    });
    if (options.signal.aborted) this.dispose();
    else this.refresh();
  }

  public refresh(): void {
    if (this.#lifetime.signal.aborted) return;
    this.#lastCell = this.options.activeCell() ?? this.#lastCell;
    const { rows, columns } = this.options.shape();
    for (const button of this.#buttons) button.disabled = rows === 0 || columns === 0;
    const labels = this.options.ui?.labels;
    if (labels) {
      for (const [index, label] of [labels.addRow, labels.addColumn, labels.menu].entries()) {
        this.#buttons[index]!.setAttribute("aria-label", label);
        this.#buttons[index]!.title = label;
      }
    }
    this.#buttons[2]!.hidden = this.options.ui === undefined;
    this.#updateVisibility();
    this.#measure();
    this.#updateTarget();
  }

  public setSuspended(suspended: boolean): void {
    if (this.#lifetime.signal.aborted || this.#suspended === suspended) return;
    this.#suspended = suspended;
    if (suspended) this.#hover.stop(this.#hoverTarget);
    this.#layer.inert = suspended;
    this.#layer.hidden = suspended || this.#visible;
    this.#root.style.opacity = this.#visible ? "1" : "0";
    this.#root.classList.toggle("inkbook-text-table-controls-hidden", !this.#visible);
    if (suspended) {
      this.#stopMotion?.();
      this.#target.hide();
    } else this.refresh();
  }

  public dispose(): void {
    this.#lifetime.abort();
    this.#hover.stop(this.#hoverTarget);
    this.#stopMotion?.();
    this.#releasePreference?.();
    this.#target.dispose();
    this.#layer.remove();
  }

  #bindVisibility(): void {
    const node = this.options.node;
    const signal = this.#lifetime.signal;
    for (const surface of [node, this.#layer]) {
      surface.addEventListener(
        "pointerenter",
        () => {
          if (!this.#suspended) this.#hover.enter(this.#hoverTarget);
        },
        { signal },
      );
      surface.addEventListener(
        "pointerleave",
        (event) => {
          this.#hover.leave(this.#hoverTarget, event, surface.ownerDocument);
          this.#updateVisibility();
        },
        { signal },
      );
      surface.addEventListener("focusin", () => this.#updateVisibility(), { signal });
      surface.addEventListener(
        "focusout",
        (event) => {
          this.#updateVisibility(event.relatedTarget);
        },
        { signal },
      );
    }
    const anchor = this.#motionAnchor();
    const ownerWindow = anchor.ownerDocument.defaultView;
    if (ownerWindow)
      this.#releasePreference = observeMenuMotionPreference(anchor, ownerWindow, () => {
        this.#stopMotion?.();
        this.#root.style.opacity = this.#visible ? "1" : "0";
      });
  }

  #bindPlacement(): void {
    const signal = this.#lifetime.signal;
    const update = () => this.#measure();
    this.options.view.dom.addEventListener(TEXT_PREVIEW_VIEWPORT_EVENT, update, { signal });
    const ownerWindow = this.#root.ownerDocument.defaultView;
    ownerWindow?.addEventListener("scroll", update, { capture: true, signal });
    ownerWindow?.addEventListener("resize", update, { signal });
    ownerWindow?.visualViewport?.addEventListener("resize", update, { signal });
    ownerWindow?.visualViewport?.addEventListener("scroll", update, { signal });
  }

  #measure(): void {
    if (!this.#visible || this.#suspended || this.#measurePending || this.#lifetime.signal.aborted)
      return;
    this.#measurePending = true;
    this.options.view.requestMeasure({
      key: this,
      read: () => {
        if (this.#lifetime.signal.aborted || this.#suspended || !this.#visible) return undefined;
        const window = this.#root.ownerDocument.defaultView;
        let following = this.options.node.nextElementSibling;
        if (following?.classList.contains("inkbook-text-line-boundary"))
          following = following.nextElementSibling;
        if (following?.classList.contains("cm-line") && !following.textContent)
          following = following.nextElementSibling;
        const project = (rect: DOMRect) => this.options.coordinates?.toDrawingRect(rect) ?? rect;
        const table = project(this.options.node.getBoundingClientRect());
        const placement = textTableControlPositions(
          table,
          window?.innerWidth ?? 0,
          window?.innerHeight ?? 0,
          this.options.coordinates
            ? project(this.options.view.dom.getBoundingClientRect())
            : this.options.node.closest("foreignObject")?.getBoundingClientRect(),
          following ? project(following.getBoundingClientRect()).top : undefined,
        );
        const bounds = {
          left: table.left,
          right: table.right,
          top: table.top,
          bottom: table.bottom,
        };
        for (const button of placement.buttons) {
          bounds.left = Math.min(bounds.left, button.left);
          bounds.right = Math.max(bounds.right, button.left + button.width);
          bounds.top = Math.min(bounds.top, button.top);
          bounds.bottom = Math.max(bounds.bottom, button.top + button.height);
        }
        return { ...placement, bounds };
      },
      write: (placement) => {
        this.#measurePending = false;
        if (this.#lifetime.signal.aborted || this.#suspended || !this.#visible || !placement)
          return;
        this.#hoverBounds = placement.visible ? placement.bounds : undefined;
        this.#layer.hidden = false;
        this.#root.classList.toggle("inkbook-text-table-controls-hidden", !placement.visible);
        placement.buttons.forEach((position, index) => {
          const style = this.#buttons[index]!.style;
          for (const [name, value] of Object.entries(position))
            style.setProperty(name, typeof value === "number" ? `${value}px` : value);
        });
        this.#updateTarget();
      },
    });
  }

  #motionAnchor(): HTMLElement {
    const frame = this.#root.ownerDocument.defaultView?.frameElement;
    return frame ? (frame as HTMLElement) : this.options.node;
  }

  #updateVisibility(
    nextFocus: EventTarget | null = this.options.node.ownerDocument.activeElement,
  ): void {
    if (this.#lifetime.signal.aborted) return;
    const focused =
      nextFocus !== null &&
      "nodeType" in nextFocus &&
      (this.options.node.contains(nextFocus as Node) ||
        this.#layer.contains(nextFocus as Node) ||
        this.#layer.contains(this.#root.ownerDocument.activeElement));
    const visible =
      this.#hovered || this.#menuOpen || focused || this.options.activeCell() !== undefined;
    if (visible === this.#visible) return;
    this.#visible = visible;
    if (this.#suspended) return;
    if (visible) this.#measure();
    const ownerWindow = this.#root.ownerDocument.defaultView;
    const opacity = ownerWindow?.getComputedStyle(this.#root).opacity ?? (visible ? "0" : "1");
    this.#stopMotion?.();
    const anchor = this.#motionAnchor();
    const motionWindow = anchor.ownerDocument.defaultView;
    this.#stopMotion = playMenuMotion(
      this.#root,
      { opacity: [Number(opacity), visible ? 1 : 0] },
      motionWindow ? effectiveTransitionDuration(anchor, motionWindow, "styleChange") : 0,
      () => {
        if (!this.#visible) this.#root.classList.add("inkbook-text-table-controls-hidden");
      },
    );
  }

  #addButton(
    kind: string,
    icon: string,
    label: string,
    action: (button: HTMLButtonElement) => void,
  ): HTMLButtonElement {
    const button = this.#root.ownerDocument.createElement("button");
    button.type = "button";
    button.className = `inkbook-text-table-${kind}`;
    button.setAttribute("aria-label", label);
    button.title = label;
    const glyph = button.ownerDocument.createElement("span");
    glyph.setAttribute("aria-hidden", "true");
    setIcon(glyph, icon);
    button.append(glyph);
    button.addEventListener("pointerdown", (event) => event.preventDefault(), {
      signal: this.#lifetime.signal,
    });
    button.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (this.#suspended) return;
        action(button);
      },
      { signal: this.#lifetime.signal },
    );
    this.#root.append(button);
    this.#buttons.push(button);
    return button;
  }

  #openMenu(anchor: HTMLButtonElement): void {
    const ui = this.options.ui;
    if (!ui || anchor.getAttribute("aria-expanded") === "true") return;
    const shape = this.options.shape();
    const cell = this.options.activeCell() ?? this.#lastCell;
    this.#menuCell = cell;
    this.#preview = undefined;
    this.#updateTarget();
    const focus = this.#root.ownerDocument.activeElement as HTMLElement | null;
    anchor.setAttribute("aria-expanded", "true");
    this.#menuOpen = true;
    this.#updateVisibility();
    ui.openMenu({
      anchor,
      ...shape,
      ...cell,
      alignment: shape.alignments?.[cell.column] ?? shape.alignment,
      signal: this.#lifetime.signal,
      onAction: (action) => {
        this.#menuCell = undefined;
        this.#target.hide();
        this.options.onAction(action);
      },
      onPreview: (action) => {
        this.#preview = action;
        this.#updateTarget();
      },
      onClose: () => {
        this.#menuCell = undefined;
        this.#target.hide();
        this.#menuOpen = false;
        anchor.setAttribute("aria-expanded", "false");
        if (!this.#lifetime.signal.aborted && focus?.isConnected)
          focus.focus({ preventScroll: true });
        this.#updateVisibility();
      },
    });
  }

  #updateTarget(): void {
    const layout = this.options.layout?.();
    if (this.#suspended || !this.#menuCell || !layout || this.#preview?.kind === "source") {
      this.#target.hide();
      return;
    }
    this.#target.show({ ...this.options.shape(), ...layout }, this.#menuCell, this.#preview);
  }
}
