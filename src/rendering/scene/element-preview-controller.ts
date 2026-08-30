import type { InkElementV1 } from "../../domain/schema/public";
import type { SceneContentRenderer } from "./content-renderer";

export class SceneElementPreviewController {
  readonly #content: SceneContentRenderer;
  readonly #elements = new Map<string, InkElementV1>();
  readonly #pending = new Set<string>();
  readonly #versions = new Map<string, number>();

  public constructor(content: SceneContentRenderer) {
    this.#content = content;
  }

  public get values(): ReadonlyMap<string, InkElementV1> {
    return this.#elements;
  }

  public set(elements: readonly InkElementV1[], version: number): boolean {
    for (const id of this.#elements.keys()) this.#versions.set(id, -1);
    for (const element of elements) {
      this.#elements.set(element.id, element);
      this.#versions.set(element.id, version);
      if (this.#content.applyElementPreview(element)) this.#pending.delete(element.id);
      else this.#pending.add(element.id);
    }
    for (const id of this.#elements.keys()) {
      if (this.#versions.get(id) === version) continue;
      this.#content.clearElementPreview(id);
      this.#elements.delete(id);
      this.#pending.delete(id);
      this.#versions.delete(id);
    }
    let promoted = false;
    for (const { id } of elements) promoted = this.#content.promoteVisible(id) || promoted;
    return promoted;
  }

  public applyMounted(): void {
    for (const id of this.#pending) {
      const element = this.#elements.get(id);
      if (element !== undefined && this.#content.applyElementPreview(element)) {
        this.#pending.delete(id);
      }
    }
  }

  public clear(): void {
    for (const id of this.#elements.keys()) this.#content.clearElementPreview(id);
    this.#elements.clear();
    this.#pending.clear();
    this.#versions.clear();
  }

  public release(): void {
    this.#elements.clear();
    this.#pending.clear();
    this.#versions.clear();
  }
}
