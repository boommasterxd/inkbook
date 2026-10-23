import { boundsIntersect } from "../../../domain/geometry/public";
import type { MountedSceneElement } from "../content/mounted-element";
import { previewPaintPadding } from "../content/element-presentation";
import type { PreviewMembershipContext } from "../types";

const SMALL_SELECTION_LIMIT = 256;

/** Reuses mounted scene membership without querying or sorting the authoritative Store. */
export class ViewportPreviewSelection {
  #source: readonly string[] | undefined;
  readonly #members = new Set<string>();
  #retained: readonly string[] = [];
  #membershipBytes = 0;

  public select(ids: readonly string[], mountedIds: Iterable<string>): readonly string[] {
    if (this.#source !== ids) this.replaceMembership(ids);
    // Preserve small offscreen selections; larger gestures never mount the complete selection.
    if (ids.length <= SMALL_SELECTION_LIMIT) this.#retained = ids;
    else {
      const selected: string[] = [];
      for (const id of mountedIds) if (this.#members.has(id)) selected.push(id);
      this.#retained = selected;
    }
    return this.#retained;
  }

  public includes(id: string): boolean {
    return this.#members.has(id);
  }

  public memoryUsage(): number {
    return (
      this.#membershipBytes + (this.#retained === this.#source ? 0 : this.#retained.length * 8)
    );
  }

  private replaceMembership(ids: readonly string[]): void {
    this.#source = ids;
    this.#members.clear();
    this.#membershipBytes = ids.length * 8;
    for (const id of ids) {
      if (this.#members.has(id)) continue;
      this.#members.add(id);
      this.#membershipBytes += id.length * 2 + 32;
    }
  }

  public clear(): void {
    this.#source = undefined;
    this.#membershipBytes = 0;
    this.#members.clear();
    this.#retained = [];
  }
}
/** Existing scene records provide culling evidence without another Store or sample traversal. */
export function* mountedPreviewIds(
  mounted: ReadonlyMap<string, MountedSceneElement>,
  visibility: { contains(id: string): boolean },
  context?: PreviewMembershipContext,
): Iterable<string> {
  const { transformBounds, envelope } = context ?? {};
  for (const [id, entry] of mounted) {
    if (
      visibility.contains(id) ||
      transformBounds === undefined ||
      envelope === undefined ||
      boundsIntersect(
        transformBounds(entry.bounds, previewPaintPadding(entry.displayedElement)),
        envelope,
      )
    )
      yield id;
  }
}
