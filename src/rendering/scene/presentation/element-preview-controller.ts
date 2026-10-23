import type { InkElementV1 } from "../../../domain/schema/public";
import type { SceneContentRenderer } from "../content-renderer";

export class SceneElementPreviewController {
  readonly #content: SceneContentRenderer;
  readonly #dirty = new Set<string>();
  readonly #elements = new Map<string, InkElementV1>();
  readonly #versions = new Map<string, number>();
  #source: readonly InkElementV1[] | undefined;

  public constructor(content: SceneContentRenderer) {
    this.#content = content;
  }

  public get values(): ReadonlyMap<string, InkElementV1> {
    return this.#elements;
  }

  public set(elements: readonly InkElementV1[], version: number): boolean {
    if (elements === this.#source) return false;
    this.#source = elements;
    for (const id of this.#elements.keys()) {
      this.#versions.set(id, -1);
    }
    for (const element of elements) {
      const previous = this.#elements.get(element.id);
      this.#elements.set(element.id, element);
      this.#versions.set(element.id, version);
      if (element !== previous) this.#dirty.add(element.id);
    }
    for (const id of this.#elements.keys()) {
      if (this.#versions.get(id) === version) continue;
      this.#dirty.add(id);
      this.#elements.delete(id);
      this.#versions.delete(id);
    }
    for (const { id } of elements) this.#content.promoteVisible(id);
    return true;
  }

  public applyMounted(ids: readonly string[]): void {
    for (const id of ids) {
      const element = this.#elements.get(id);
      if (element !== undefined) this.#apply(element);
    }
  }

  public write(): void {
    for (const id of this.#dirty) {
      const element = this.#elements.get(id);
      if (element === undefined) this.#content.clearElementPreview(id);
      else this.#apply(element);
    }
    this.#dirty.clear();
  }

  public clear(): void {
    for (const id of this.#elements.keys()) this.#dirty.add(id);
    this.#reset();
  }

  public release(): void {
    this.#dirty.clear();
    this.#reset();
  }

  #reset(): void {
    this.#elements.clear();
    this.#versions.clear();
    this.#source = undefined;
  }

  #apply(element: InkElementV1): void {
    this.#content.applyElementPreview(element);
  }
}
