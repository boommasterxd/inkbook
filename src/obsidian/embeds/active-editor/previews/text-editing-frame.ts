import type { InkElementV1, TextElementV2 } from "../../../../domain/schema/public";
import {
  createSelectionFrameAtRotation,
  type OrientedSelectionFrame,
  type SelectedElementGeometry,
  type SelectionFrameSession,
} from "../../../../editor/selection/public";

/** Source reveal changes only the selected presentation, never document geometry. */
export class TextEditingFrame {
  #extent:
    | { readonly id: string; readonly height: number; readonly basis: TextElementV2 | undefined }
    | undefined;
  #element: InkElementV1 | undefined;
  #frame: OrientedSelectionFrame | null = null;

  public set(id: string, height: number | undefined, basis?: TextElementV2): boolean {
    if (height !== undefined && (!Number.isFinite(height) || height < 0)) return false;
    if (basis && basis.id !== id) return false;
    if (height === undefined && this.#extent?.id !== id) return false;
    if (this.#extent?.id === id && this.#extent.height === height && this.#extent.basis === basis)
      return false;
    this.#extent = height === undefined ? undefined : { id, height, basis };
    this.#element = undefined;
    this.#frame = null;
    return true;
  }

  public resolve(
    selected: readonly SelectedElementGeometry[],
    frames: SelectionFrameSession,
  ): OrientedSelectionFrame | null {
    return this.preview(selected) ?? frames.current(selected);
  }

  public preview(selected: readonly SelectedElementGeometry[]): OrientedSelectionFrame | null {
    const element = selected.length === 1 ? selected[0]?.element : undefined;
    const extent = this.#extent;
    if (!extent || element?.kind !== "text" || element.id !== extent.id) return null;
    const basis = extent.basis;
    const factor =
      basis && basis !== element
        ? basis.height > 0
          ? element.height / basis.height
          : element.width / basis.width
        : 1;
    const height = extent.height * factor;
    if (!Number.isFinite(height) || height <= element.height) return null;
    if (this.#element !== element) {
      this.#element = element;
      this.#frame = createSelectionFrameAtRotation([{ ...element, height }], element.rotation);
    }
    return this.#frame;
  }
}
