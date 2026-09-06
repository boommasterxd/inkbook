import type { InkElementV1 } from "../../domain/schema/public";
import type { SceneContentRenderer } from "./content-renderer";

export class SceneElementPreviewController {
  readonly #content: SceneContentRenderer;
  readonly #dirty = new Set<string>();
  readonly #elements = new Map<string, InkElementV1>();
  readonly #pressurePreviewIds = new Set<string>();
  readonly #activePressureIds = new Set<string>();
  readonly #versions = new Map<string, number>();
  #source: readonly InkElementV1[] | undefined;
  #pressurePreviewSource: ReadonlySet<string> | undefined;
  #activePressureSource: readonly string[] | undefined;

  public constructor(content: SceneContentRenderer) {
    this.#content = content;
  }

  public get values(): ReadonlyMap<string, InkElementV1> {
    return this.#elements;
  }

  public set(
    elements: readonly InkElementV1[],
    version: number,
    pressurePreviewIds?: ReadonlySet<string>,
  ): boolean {
    if (elements === this.#source && pressurePreviewIds === this.#pressurePreviewSource)
      return false;
    this.#source = elements;
    this.#pressurePreviewSource = pressurePreviewIds;
    this.#activePressureSource = undefined;
    for (const id of this.#elements.keys()) {
      this.#versions.set(id, -1);
    }
    for (const element of elements) {
      const previous = this.#elements.get(element.id);
      const previousPressurePreview = this.#pressurePreviewIds.has(element.id);
      const pressurePreview = pressurePreviewIds?.has(element.id) ?? false;
      this.#elements.set(element.id, element);
      if (pressurePreview) this.#pressurePreviewIds.add(element.id);
      else this.#pressurePreviewIds.delete(element.id);
      this.#versions.set(element.id, version);
      if (element !== previous || pressurePreview !== previousPressurePreview)
        this.#dirty.add(element.id);
    }
    for (const id of this.#elements.keys()) {
      if (this.#versions.get(id) === version) continue;
      this.#dirty.add(id);
      this.#elements.delete(id);
      this.#pressurePreviewIds.delete(id);
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

  public write(activeIds: readonly string[]): void {
    this.#refreshActivePressureIds(activeIds);
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
    this.#pressurePreviewIds.clear();
    this.#versions.clear();
    this.#source = undefined;
    this.#pressurePreviewSource = undefined;
    this.#activePressureSource = undefined;
    this.#activePressureIds.clear();
  }

  #apply(element: InkElementV1): void {
    if (this.#pressurePreviewIds.has(element.id) && !this.#activePressureIds.has(element.id)) {
      this.#content.clearElementPreview(element.id);
      return;
    }
    this.#content.applyElementPreview(element, this.#activePressureIds.has(element.id));
  }

  #refreshActivePressureIds(ids: readonly string[]): void {
    if (ids === this.#activePressureSource) return;
    this.#activePressureSource = ids;
    const next = new Set(ids.filter((id) => this.#pressurePreviewIds.has(id)));
    for (const id of this.#activePressureIds) {
      if (!next.has(id)) this.#dirty.add(id);
    }
    for (const id of next) {
      if (!this.#activePressureIds.has(id)) this.#dirty.add(id);
    }
    this.#activePressureIds.clear();
    for (const id of next) this.#activePressureIds.add(id);
  }
}
