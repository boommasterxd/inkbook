/** Separates animated root-height changes from toolbar and available-width changes. */
export class ToolbarResizeObservation {
  #rootInlineSize: number | undefined;

  affectsToolbar(entries: readonly ResizeObserverEntry[], root: HTMLElement): boolean {
    let changed = entries.length === 0;
    for (const entry of entries) {
      if (entry.target !== root) {
        changed = true;
        continue;
      }
      const width = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
      if (!Number.isFinite(width) || width <= 0) {
        this.#rootInlineSize = undefined;
        changed = true;
        continue;
      }
      if (width !== this.#rootInlineSize) changed = true;
      this.#rootInlineSize = width;
    }
    return changed;
  }
}
