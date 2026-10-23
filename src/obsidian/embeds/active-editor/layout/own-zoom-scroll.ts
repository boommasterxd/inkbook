import { browserScrollMetrics, type BrowserScrollElement } from "../../../scrolling/index";
import { readScrollOwnerViewport } from "../../active-scene/active-scene-viewport";
import {
  projectNavigationCursorLayout,
  sameNavigationLayout,
  type NavigationCursorLayout,
  type NavigationLayoutRead,
} from "../navigation/navigation-layout";
import type { ElementContentBox } from "./element-content-box";
import type { ActiveEditorLayoutOptions } from "./layout-contracts";

interface GeometryRevision {
  readonly scene: number;
  readonly host: number;
}

interface OwnZoomProjection {
  readonly before: NavigationLayoutRead;
  readonly blockSize: number;
  readonly revision: GeometryRevision;
}

interface OwnZoomScroll extends OwnZoomProjection {
  readonly layout: NavigationCursorLayout;
}

type OwnZoomScrollOptions = Pick<
  ActiveEditorLayoutOptions,
  "container" | "renderer" | "readHostGeometryRevision"
>;

/** Consumes one own-scroll report only while its projected host geometry still holds. */
export class OwnZoomScrollProof {
  readonly #options: OwnZoomScrollOptions;
  #projection: OwnZoomProjection | undefined;
  #pending: OwnZoomScroll | undefined;

  public constructor(options: OwnZoomScrollOptions) {
    this.#options = options;
  }

  public record(before: NavigationLayoutRead | undefined, blockSize: number): void {
    this.clear();
    if (before?.containerBorderBounds === undefined) return;
    this.#projection = { before, blockSize, revision: this.#revision() };
  }

  public adopt(layout: NavigationCursorLayout): void {
    const projection = this.#projection;
    this.clear();
    if (projection === undefined || projection.before.scrollTop === layout.scrollTop) return;
    const expected = projectNavigationCursorLayout(projection.before, {
      blockSize: projection.blockSize,
      scrollTop: layout.scrollTop,
    });
    if (!sameNavigationLayout(expected, layout)) return;
    this.#pending = { ...projection, layout };
  }

  public consume(owner: BrowserScrollElement): boolean {
    const container = this.#options.container;
    const revision = this.#revision();
    const pending = this.#pending;
    this.clear();
    if (
      pending === undefined ||
      pending.revision.scene !== revision.scene ||
      pending.revision.host !== revision.host ||
      pending.layout.scrollOwner !== owner ||
      pending.layout.ownerWindow !== container.ownerDocument.defaultView ||
      pending.layout.ownerWindow !== owner.ownerDocument.defaultView ||
      container.isConnected === false ||
      browserScrollMetrics.getScrollTop(owner) !== pending.layout.scrollTop
    )
      return false;
    const border = pending.before.containerBorderBounds!;
    const top = border.top + pending.before.scrollTop - pending.layout.scrollTop;
    const height = border.height + pending.blockSize - pending.before.containerBounds.height;
    const expectedBorder = { left: border.left, right: border.right, top, bottom: top + height };
    // Host content can move without resizing the widget or changing scrollTop.
    // Validate raw rectangles, retaining the already measured content insets.
    const currentBorder = container.getBoundingClientRect();
    const currentViewport = readScrollOwnerViewport(owner);
    return (
      sameBounds(expectedBorder, currentBorder) &&
      sameBounds(pending.layout.ownerViewport, currentViewport)
    );
  }

  public clear(): void {
    this.#projection = undefined;
    this.#pending = undefined;
  }

  #revision(): GeometryRevision {
    return {
      scene: this.#options.renderer.layoutInvalidationVersion,
      host: this.#options.readHostGeometryRevision?.() ?? 0,
    };
  }
}

function sameBounds(
  expected: Pick<ElementContentBox, "top" | "left" | "right" | "bottom">,
  current: Pick<ElementContentBox, "top" | "left" | "right" | "bottom">,
): boolean {
  return (
    expected.top === current.top &&
    expected.left === current.left &&
    expected.right === current.right &&
    expected.bottom === current.bottom
  );
}
