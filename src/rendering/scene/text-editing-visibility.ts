import type { MountedTextPresentation } from "./content/mounted-text";
import type { TextElementV2 } from "../../domain/schema/public";

/** Switches between the native input and canonical presentation without moving either. */
export function createTextEditingVisibility(
  text: MountedTextPresentation,
  node: SVGForeignObjectElement,
  onContentHeightChanged?: (height: number | undefined, basis: TextElementV2) => void,
) {
  let disposed = false;
  let ready = false;
  let visible = true;
  let editing = false;
  let painted = false;
  let height = text.element.height;
  let basis = text.element;
  let publishedHeight: number | undefined;
  let publishedBasis: TextElementV2 | undefined;
  const publishHeight = () => {
    const next = painted ? height : undefined;
    if (next === publishedHeight && (next === undefined || basis === publishedBasis)) return;
    publishedHeight = next;
    publishedBasis = basis;
    onContentHeightChanged?.(next, basis);
  };
  const sync = () => {
    const nextEditing = ready;
    if (editing !== nextEditing) {
      editing = nextEditing;
      if (editing) {
        text.content.setAttribute("visibility", "hidden");
        text.group.setAttribute("data-inkbook-text-editor-ready", "");
      } else {
        text.content.removeAttribute("visibility");
        text.group.removeAttribute("data-inkbook-text-editor-ready");
      }
    }
    const nextPainted = editing && visible;
    if (painted === nextPainted) return;
    painted = nextPainted;
    node.setAttribute("visibility", painted ? "visible" : "hidden");
    publishHeight();
  };
  return {
    updateHeight: (next: number, nativeBasis = basis) => {
      if (disposed) return;
      height = next;
      basis = nativeBasis;
      publishHeight();
    },
    setReady: () => {
      if (disposed || ready) return;
      ready = true;
      node.setAttribute("data-inkbook-text-editor-ready", "");
      sync();
    },
    setVisibility: (next: boolean) => {
      if (disposed || visible === next) return;
      visible = next;
      sync();
    },
    setSuspended: (next: boolean) => {
      if (disposed) return;
      node.setAttribute("pointer-events", next ? "none" : "auto");
    },
    dispose: () => {
      disposed = true;
      painted = false;
      publishHeight();
      text.content.removeAttribute("visibility");
      text.group.removeAttribute("data-inkbook-text-editor-ready");
    },
  };
}
