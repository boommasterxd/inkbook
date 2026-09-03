import type { InkElementV1 } from "../../domain/schema/public";
import type { SceneContentRenderer } from "./content-renderer";

export class SceneElementPreviewController {
  readonly #content: SceneContentRenderer;
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
    for (const id of this.#elements.keys()) this.#versions.set(id, -1);
    for (const element of elements) {
      this.#elements.set(element.id, element);
      this.#versions.set(element.id, version);
      this.#content.applyElementPreview(element);
    }
    for (const id of this.#elements.keys()) {
      if (this.#versions.get(id) === version) continue;
      this.#content.clearElementPreview(id);
      this.#elements.delete(id);
      this.#versions.delete(id);
    }
    let promoted = false;
    for (const { id } of elements) promoted = this.#content.promoteVisible(id) || promoted;
    return promoted;
  }

  public applyMounted(ids: readonly string[]): void {
    for (const id of ids) {
      const element = this.#elements.get(id);
      if (element !== undefined) this.#content.applyElementPreview(element);
    }
  }

  public clear(): void {
    for (const id of this.#elements.keys()) this.#content.clearElementPreview(id);
    this.#elements.clear();
    this.#versions.clear();
    this.#source = undefined;
  }

  public release(): void {
    this.#elements.clear();
    this.#versions.clear();
    this.#source = undefined;
  }
}
