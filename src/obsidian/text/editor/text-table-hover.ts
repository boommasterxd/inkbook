import type { TextEditingCoordinates } from "../../../rendering/scene/text-editing-geometry";
import type { TableControlBounds } from "./text-table-control-position";

export interface TextTableHoverTarget {
  readonly node: HTMLElement;
  readonly layer: HTMLElement;
  readonly coordinates?: TextEditingCoordinates | undefined;
  readonly bounds: () => TableControlBounds | undefined;
  readonly changed: (hovered: boolean) => void;
}

/** One editor owns at most one cross-document pointer corridor, regardless of table count. */
export class TextTableHover {
  #active:
    { readonly target: TextTableHoverTarget; readonly lifetime: AbortController } | undefined;

  public enter(target: TextTableHoverTarget): void {
    if (this.#active?.target === target) return;
    this.stop();
    const lifetime = new AbortController();
    this.#active = { target, lifetime };
    const signal = lifetime.signal;
    const drawing = target.layer.ownerDocument;
    for (const document of new Set([target.node.ownerDocument, drawing])) {
      document.addEventListener(
        "pointermove",
        (event) => {
          if (!containsTarget(target, event.target)) this.#move(target, event, document);
        },
        { capture: true, signal },
      );
      document.addEventListener("pointercancel", () => this.stop(target), { signal });
      document.addEventListener(
        "visibilitychange",
        () => {
          if (document.hidden) this.stop(target);
        },
        { signal },
      );
      document.defaultView?.addEventListener("blur", () => this.stop(target), { signal });
    }
    drawing.documentElement.addEventListener("pointerleave", () => this.stop(target), { signal });
    target.changed(true);
  }

  public leave(target: TextTableHoverTarget, event: PointerEvent, document: Document): void {
    if (this.#active?.target !== target) return;
    if (containsTarget(target, event.relatedTarget)) return;
    this.#move(target, event, document);
  }

  public stop(target = this.#active?.target): void {
    if (!this.#active || this.#active.target !== target) return;
    this.#active.lifetime.abort();
    this.#active = undefined;
    target?.changed(false);
  }

  #move(target: TextTableHoverTarget, event: PointerEvent, document: Document): void {
    const bounds = target.bounds();
    const local = { x: event.clientX, y: event.clientY };
    const point =
      document === target.layer.ownerDocument ? local : target.coordinates?.toDrawingPoint(local);
    if (
      !bounds ||
      !point ||
      point.x < bounds.left ||
      point.x > bounds.right ||
      point.y < bounds.top ||
      point.y > bounds.bottom
    )
      this.stop(target);
  }
}

/** Native hit testing remains authoritative before the first deferred placement is ready. */
function containsTarget(target: TextTableHoverTarget, next: EventTarget | null): boolean {
  return (
    next !== null &&
    "nodeType" in next &&
    (target.node.contains(next as Node) || target.layer.contains(next as Node))
  );
}
