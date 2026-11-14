import type { MountedTextPresentation } from "./content/mounted-text";
import { TextEditingViewport, type TextEditingViewportContext } from "./text-editing-viewport";
import type {
  TextClientRect,
  TextEditingBounds,
  TextEditingCoordinates,
} from "./text-editing-geometry";
import { TextEditingInputDocument } from "./text-editing-input-document";
import type { SceneCamera, SceneViewport } from "./types";
import type { Bounds } from "../../domain/geometry/primitives";
import type { TextElementV2 } from "../../domain/schema/public";
import { createTextEditingVisibility } from "./text-editing-visibility";
export type { TextEditingBounds } from "./text-editing-geometry";

export interface TextEditingCallbacks {
  readonly ownsPointerTarget?: (target: EventTarget | null) => boolean;
  readonly onPointerDown?: (event: PointerEvent) => boolean;
  readonly onOutsidePointerDown?: (event: PointerEvent) => void;
  readonly onKeyDown?: (event: KeyboardEvent) => void;
  readonly onDocumentInvalidated?: () => void;
  readonly onViewportChanged?: (geometryChanged?: boolean) => void;
  readonly onContentHeightChanged?:
    ((height: number | undefined, basis: TextElementV2) => void) | undefined;
  readonly onGeometryChanged?: (element: TextElementV2) => void;
}

export interface TextEditingSurface {
  readonly container: HTMLDivElement;
  readonly ownerDocument: Document;
  readonly coordinates: TextEditingCoordinates;
  readonly ready: Promise<void>;
  readonly prepareDocument: () => Promise<void>;
  readonly updateBounds: (bounds: TextEditingBounds, basis?: TextElementV2) => void;
  readonly setVisibility: (visible: boolean) => void;
  readonly setSuspended: (suspended: boolean) => void;
  readonly syncGeometry?: () => void;
  readonly setReady?: () => void;
  readonly dispose: () => void;
  readonly updateViewport: (viewport: SceneViewport, camera: SceneCamera) => void;
  readonly pageBoundsForClientRect: (rect: TextClientRect) => Bounds | undefined;
  readonly setContentHeight: (height: number) => Bounds | undefined;
}

/** Runtime-only editor inherits its authoritative text group's paint position and transforms. */
export function createTextEditingSurface(
  text: MountedTextPresentation,
  bounds: TextEditingBounds,
  callbacks: TextEditingCallbacks,
  release: () => void,
  context?: TextEditingViewportContext,
): TextEditingSurface {
  const drawingDocument = text.group.ownerDocument;
  const input = new TextEditingInputDocument({
    group: text.group,
    prepareDocument: context?.prepareDocument,
    onInvalidated: () => callbacks.onDocumentInvalidated?.(),
  });
  const { container, node, clip, document: ownerDocument } = input;
  const appliedBounds = new Map<keyof TextEditingBounds, number>();
  const visibility = createTextEditingVisibility(text, node, callbacks.onContentHeightChanged);
  const releaseInput = bindTextEditingInput(container, node, callbacks);
  let disposed = false;
  let geometryActive = false;
  let presented = text.element;
  let nativeBasis = text.element;
  const writeBounds = (next: TextEditingBounds) => {
    for (const name of ["x", "y", "width", "height"] as const) {
      if (appliedBounds.get(name) === next[name]) continue;
      node.setAttribute(name, String(next[name]));
      appliedBounds.set(name, next[name]);
    }
    visibility.updateHeight(next.height, nativeBasis);
  };
  const viewport = new TextEditingViewport({
    text,
    clip,
    container,
    isolatedInput: true,
    bounds,
    context,
    onChanged: callbacks.onViewportChanged,
    onBoundsChanged: writeBounds,
  });
  const updateBounds = (next: TextEditingBounds, basis = text.element) => {
    if (disposed) return;
    nativeBasis = basis;
    viewport.updateBounds(next);
    visibility.updateHeight(appliedBounds.get("height") ?? next.height, nativeBasis);
  };
  updateBounds(bounds);
  return {
    container,
    ownerDocument,
    ready: input.ready,
    prepareDocument: () => input.prepare(),
    coordinates: {
      drawingDocument,
      toDrawingPoint: (point) => viewport.toDrawingPoint(point),
      fromDrawingPoint: (point) => viewport.fromDrawingPoint(point),
      toDrawingRect: (rect) => viewport.toDrawingRect(rect),
    },
    updateBounds,
    updateViewport: (next, camera) => viewport.update(next, camera),
    syncGeometry: () => {
      if (disposed) return;
      if (geometryActive && presented !== text.element) {
        presented = text.element;
        callbacks.onGeometryChanged?.(presented);
        visibility.updateHeight(appliedBounds.get("height") ?? presented.height, nativeBasis);
      }
    },
    pageBoundsForClientRect: (rect) => viewport.pageBounds(rect),
    setContentHeight: (height) => viewport.setContentHeight(height),
    setReady: () => {
      if (input.valid) visibility.setReady();
    },
    setVisibility: (visible) => {
      if (input.valid) visibility.setVisibility(visible);
    },
    setSuspended: (next) => {
      if (disposed) return;
      geometryActive = next;
      presented = text.element;
      visibility.setSuspended(next);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      viewport.release();
      appliedBounds.clear();
      releaseInput();
      visibility.dispose();
      input.dispose();
      release();
    },
  };
}

/** The same native input listeners survive geometry publication and end with the surface. */
function bindTextEditingInput(
  container: HTMLElement,
  node: SVGForeignObjectElement,
  callbacks: TextEditingCallbacks,
): () => void {
  const ownerDocument = container.ownerDocument;
  const pointer = (event: PointerEvent) => {
    if (callbacks.onPointerDown?.(event) === true) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (callbacks.ownsPointerTarget?.(event.target)) return;
    if (!container.contains(event.target as Node) && !node.contains(event.target as Node))
      callbacks.onOutsidePointerDown?.(event);
  };
  const key = (event: KeyboardEvent) => callbacks.onKeyDown?.(event);
  ownerDocument.addEventListener("pointerdown", pointer, true);
  node.ownerDocument.addEventListener("pointerdown", pointer, true);
  ownerDocument.addEventListener("keydown", key, true);
  return () => {
    ownerDocument.removeEventListener("pointerdown", pointer, true);
    node.ownerDocument.removeEventListener("pointerdown", pointer, true);
    ownerDocument.removeEventListener("keydown", key, true);
  };
}
