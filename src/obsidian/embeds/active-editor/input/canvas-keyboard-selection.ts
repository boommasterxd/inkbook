import type { ElementStore } from "../../../../domain/store/public";
import type { PointV1 } from "../../../../domain/schema/public";
import type { ActiveEditorNavigation } from "../navigation/navigation";
import {
  KeyboardHandleInteraction,
  keyboardHandleName,
  type KeyboardHandleOptions,
} from "../previews/keyboard-handle-interaction";
import { CanvasKeyboardStatus } from "./canvas-keyboard-status";

export interface CanvasKeyboardSelectionOptions extends Omit<KeyboardHandleOptions, "settled"> {
  readonly navigation: ActiveEditorNavigation;
  readonly setSelection: (selection: ReadonlySet<string>) => void;
  readonly enabled: () => boolean;
}

/** Fixed canvas keys operate only on its focused input surface, never on host controls. */
export class CanvasKeyboardSelection {
  readonly #options: CanvasKeyboardSelectionOptions;
  readonly #surface: HTMLElement;
  readonly #status: CanvasKeyboardStatus;
  readonly #geometry: KeyboardHandleInteraction;
  readonly #store: ElementStore;
  #editing = false;
  #handle = -1;
  #selectedId: string | undefined;
  #disposed = false;

  public constructor(options: CanvasKeyboardSelectionOptions) {
    this.#options = options;
    this.#store = options.controller.model.store;
    this.#surface = options.controller.renderer.inputSurface;
    this.#status = new CanvasKeyboardStatus(this.#surface);
    this.#geometry = new KeyboardHandleInteraction({
      ...options,
      settled: (committed) => {
        if (!this.#disposed)
          this.#announce(committed ? "Updated." : "The edit could not be applied.");
      },
    });
    this.#surface.addEventListener("pointerdown", this.#pointer, true);
    this.#surface.addEventListener("blur", this.#blur);
    this.#surface.ownerDocument.addEventListener("keydown", this.#pendingExit, true);
  }

  public handle(event: KeyboardEvent): boolean {
    if (
      this.#disposed ||
      event.target !== this.#surface ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return false;
    if (event.key === "Tab") {
      this.cancel();
      return false;
    }
    if (event.key === "Escape") return this.cancel();
    if (!this.#options.enabled()) return false;
    return this.#editKey(event) || this.#navigationKey(event);
  }

  #editKey(event: KeyboardEvent): boolean {
    if (event.key === "Enter") {
      if (event.repeat || this.#options.selection().size === 0) return this.#editing;
      this.#editing = !this.#editing;
      this.#handle = -1;
      this.#announce(this.#editing ? "Geometry editing." : "Geometry editing closed.");
      return true;
    }
    if (!this.#editing) return false;
    if (event.key === "PageDown" || event.key === "PageUp") {
      const direction = event.key === "PageDown" ? 1 : -1;
      this.#cycleHandle(direction);
      return true;
    }
    const delta = arrowDelta(event.key, event.shiftKey ? 10 : 1);
    if (delta === null) return false;
    this.#geometry.step(this.#handle, delta);
    return true;
  }

  #navigationKey(event: KeyboardEvent): boolean {
    if (this.#editing) return false;
    if (event.key === "PageDown" || event.key === "PageUp") {
      this.#navigate(event.key === "PageDown" ? 1 : -1, event.shiftKey);
      return true;
    }
    if (event.key === "Home" || event.key === "End") {
      this.#selectRank(event.key === "Home" ? 0 : this.#store.size - 1, event.shiftKey);
      return true;
    }
    return false;
  }

  public cancel(): boolean {
    const editing = this.#editing;
    this.#editing = false;
    this.#handle = -1;
    this.#geometry.cancel();
    if (editing && !this.#disposed) this.#status.announce("Geometry editing closed.");
    return editing;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.cancel();
    this.#surface.removeEventListener("pointerdown", this.#pointer, true);
    this.#surface.removeEventListener("blur", this.#blur);
    this.#surface.ownerDocument.removeEventListener("keydown", this.#pendingExit, true);
    this.#status.dispose();
  }

  readonly #pointer = (): void => {
    this.cancel();
  };
  readonly #blur = (): void => {
    if (!this.#geometry.pending) this.cancel();
  };
  readonly #pendingExit = (event: KeyboardEvent): void => {
    if (
      !this.#geometry.pending ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.isComposing
    )
      return;
    const document = this.#surface.ownerDocument;
    const active = document.activeElement;
    if (active !== this.#surface && active !== document.body && active !== document.documentElement)
      return;
    if (event.key !== "Escape" && event.key !== "Tab") return;
    this.cancel();
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  #navigate(direction: number, additive: boolean): void {
    const selection = this.#options.selection();
    const id =
      this.#selectedId !== undefined && selection.has(this.#selectedId)
        ? this.#selectedId
        : selection.values().next().value;
    const rank = id === undefined ? undefined : this.#store.getRank(id);
    const current =
      rank === undefined
        ? direction > 0
          ? -1
          : this.#store.size
        : rank.rank + (rank.band === "content" ? this.#store.bandSize("highlight") : 0);
    this.#selectRank(current + direction, additive);
  }

  #selectRank(index: number, additive: boolean): void {
    const bounded = Math.min(this.#store.size - 1, Math.max(0, index));
    const highlights = this.#store.bandSize("highlight");
    const id =
      bounded < highlights
        ? this.#store.idAtRank("highlight", bounded)
        : this.#store.idAtRank("content", bounded - highlights);
    if (id === undefined) {
      this.#status.announce("The drawing is empty.");
      return;
    }
    this.#selectedId = id;
    const next = additive ? new Set(this.#options.selection()) : new Set<string>();
    next.add(id);
    this.#options.setSelection(next);
    const record = this.#store.get(id)!;
    this.#options.navigation.revealBounds(record.bounds);
    this.#status.announce(
      `${record.element.kind}, object ${bounded + 1} of ${this.#store.size}. ${next.size} selected.`,
    );
  }

  #cycleHandle(direction: number): void {
    const count = this.#geometry.choices().length + 1;
    this.#handle = ((this.#handle + 1 + direction + count) % count) - 1;
    this.#announce();
  }

  #announce(prefix = ""): void {
    if (this.#disposed) return;
    this.#geometry.focus(this.#editing ? this.#handle : null);
    const name = this.#editing ? keyboardHandleName(this.#geometry.choices()[this.#handle]) : "";
    const first = this.#options.selection().values().next().value;
    const record = first === undefined ? undefined : this.#store.get(first);
    const coordinates =
      record === undefined
        ? ""
        : `First selected object: X ${rounded(record.bounds.minX)}, Y ${rounded(record.bounds.minY)}, width ${rounded(record.bounds.maxX - record.bounds.minX)}, height ${rounded(record.bounds.maxY - record.bounds.minY)}, rotation ${rounded(record.element.rotation)} degrees.`;
    this.#status.announce([prefix, name, coordinates].filter(Boolean).join(" "));
  }
}

function rounded(value: number): number {
  return Number(value.toFixed(2));
}

function arrowDelta(key: string, amount: number): PointV1 | null {
  switch (key) {
    case "ArrowLeft":
      return { x: -amount, y: 0 };
    case "ArrowRight":
      return { x: amount, y: 0 };
    case "ArrowUp":
      return { x: 0, y: -amount };
    case "ArrowDown":
      return { x: 0, y: amount };
    default:
      return null;
  }
}
