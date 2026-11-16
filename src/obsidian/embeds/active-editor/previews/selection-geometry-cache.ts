import type { SpatialBounds } from "../../../../domain/spatial/index";
import type { SelectedElementGeometry } from "../../../../editor/selection/public";
import type { ElementSceneStore } from "../scene-store";

/** Membership and record revision own editable geometry and the fixed selection outline. */
export class SelectionGeometryCache {
  #selection: ReadonlySet<string> | undefined;
  #revision = -1;
  #size = -1;
  public editable: readonly SelectedElementGeometry[] = [];
  public editableIds: ReadonlySet<string> = new Set();
  public lockedBounds: SpatialBounds | undefined;

  public invalidate(): void {
    this.#selection = undefined;
  }

  public release(): void {
    this.invalidate();
    this.editable = [];
    this.editableIds = new Set();
    this.lockedBounds = undefined;
  }

  public read(
    store: ElementSceneStore,
    selection: ReadonlySet<string>,
    revision: number,
  ): readonly SelectedElementGeometry[] {
    if (
      this.#selection === selection &&
      this.#size === selection.size &&
      this.#revision === revision
    )
      return this.editable;
    const editable: SelectedElementGeometry[] = [];
    let sameEditableIds = true;
    this.lockedBounds = undefined;
    for (const id of selection) {
      const record = store.get(id);
      if (record === undefined) continue;
      if (record.element.locked !== true) {
        editable.push({ bounds: record.bounds, element: record.element });
        sameEditableIds &&= this.editableIds.has(id);
      } else this.#includeLocked(record.bounds);
    }
    this.#selection = selection;
    this.#size = selection.size;
    this.#revision = revision;
    this.editable = editable;
    this.editableIds =
      editable.length === selection.size
        ? selection
        : sameEditableIds && editable.length === this.editableIds.size
          ? this.editableIds
          : new Set(editable.map(({ element }) => element.id));
    return editable;
  }

  #includeLocked(bounds: SpatialBounds): void {
    const previous = this.lockedBounds;
    this.lockedBounds = {
      minX: Math.min(previous?.minX ?? bounds.minX, bounds.minX),
      minY: Math.min(previous?.minY ?? bounds.minY, bounds.minY),
      maxX: Math.max(previous?.maxX ?? bounds.maxX, bounds.maxX),
      maxY: Math.max(previous?.maxY ?? bounds.maxY, bounds.maxY),
    };
  }
}
