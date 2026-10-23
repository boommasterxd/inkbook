import {
  sameNavigationLayout,
  type NavigationCursorLayout,
  type NavigationLayoutRead,
} from "../navigation/navigation-layout";

interface RootSize {
  readonly width: number;
  readonly height: number;
}
interface OwnResize {
  readonly before: NavigationLayoutRead;
  readonly blockSize: number;
  readonly root: RootSize;
  layout?: NavigationCursorLayout;
}

/** A one-notification proof for an own height write already projected into the scene. */
export class OwnZoomResize {
  #root: RootSize | undefined;
  #pending: OwnResize | undefined;

  public record(before: NavigationLayoutRead | undefined, blockSize: number): void {
    const previous = this.#pending;
    this.#pending = undefined;
    if (before === undefined || this.#root === undefined) return;
    if (previous !== undefined && !sameNavigationLayout(previous.layout, before)) return;
    const root = previous?.root ?? this.#root;
    this.#pending = {
      before,
      blockSize,
      root: { width: root.width, height: root.height + blockSize - before.containerBounds.height },
    };
  }

  public adopt(layout: NavigationCursorLayout): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    if (
      layout.scrollOwner !== pending.before.scrollOwner ||
      layout.ownerWindow !== pending.before.ownerWindow ||
      layout.containerBounds.height !== pending.blockSize
    ) {
      this.#pending = undefined;
      return;
    }
    pending.layout = layout;
  }

  public consume(
    entries: readonly ResizeObserverEntry[],
    root: HTMLElement,
    read: (() => NavigationLayoutRead | undefined) | undefined,
  ): boolean {
    const pending = this.#pending;
    this.#pending = undefined;
    const entry = entries.find((candidate) => candidate.target === root);
    if (entry === undefined) return false;
    const { width, height } = entry.contentRect;
    this.#root =
      Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
        ? { width, height }
        : undefined;
    if (
      entries.length !== 1 ||
      pending?.layout === undefined ||
      this.#root === undefined ||
      width !== pending.root.width ||
      height !== pending.root.height
    )
      return false;
    const measured = read?.();
    return measured !== undefined && sameNavigationLayout(pending.layout, measured);
  }
}
