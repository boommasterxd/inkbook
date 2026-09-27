import type { InkElementV1 } from "../../domain/schema/public";
import type { PreviewTransform } from "./scene-mount-preparation";

/** Tracks offscreen nodes that remain mounted solely while a preview owns them. */
export class DeferredVisibilityExits {
  readonly #ids = new Set<string>();

  public get size(): number {
    return this.#ids.size;
  }

  public skipped(id: string, visible: boolean, mounted: boolean): void {
    if (visible || !mounted) this.#ids.delete(id);
    else this.#ids.add(id);
  }

  public removed(id: string): void {
    this.#ids.delete(id);
  }

  public hasUnprotected(
    transforms: ReadonlyMap<string, PreviewTransform>,
    elements: ReadonlyMap<string, InkElementV1>,
  ): boolean {
    for (const id of this.#ids) {
      if (transforms.get(id)?.transform == null && !elements.has(id)) return true;
    }
    return false;
  }

  public drainInto(target: string[]): void {
    target.push(...this.#ids);
    this.#ids.clear();
  }

  public clear(): void {
    this.#ids.clear();
  }
}
