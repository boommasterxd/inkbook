import type { SvgPathPart } from "../../../domain/geometry/element-path";
import type { InkElementV1, TextElementV2 } from "../../../domain/schema/public";
import type { MountedSceneElement } from "./mounted-element";
import type { SceneStorePort } from "../types";

const NO_PATHS: readonly SvgPathPart[] = [];

interface TextPreview {
  readonly element: TextElementV2;
  readonly parts: readonly SvgPathPart[];
}

/** Retains only the latest requested glyph publication for each mounted text field. */
export class TextPreviewPublication {
  readonly #pending = new Map<string, TextPreview>();

  public constructor(
    private readonly mounted: ReadonlyMap<string, MountedSceneElement>,
    private readonly store: SceneStorePort,
  ) {}

  public get pending(): boolean {
    return this.#pending.size > 0;
  }

  public memoryUsage(): number {
    return this.#pending.size * 64;
  }

  public defer(
    entry: MountedSceneElement,
    element: InkElementV1,
    parts: readonly SvgPathPart[],
  ): boolean {
    const text = entry.text;
    if (element.kind !== "text" || text === undefined) return false;
    if (this.#pending.get(element.id)?.element !== element) this.cancel(element.id);
    if (text.element === element) return false;
    this.#pending.set(element.id, { element, parts });
    return true;
  }

  public cancel(id: string): void {
    if (this.#pending.delete(id)) this.mounted.get(id)?.text?.cancelPreparation();
  }

  public canonical(id: string): void {
    this.cancel(id);
    const entry = this.mounted.get(id);
    if (entry?.text === undefined) return;
    const element = this.store.get(id)?.element;
    if (element?.kind === "text") this.defer(entry, element, NO_PATHS);
  }

  public release(): void {
    for (const id of this.#pending.keys()) this.cancel(id);
  }

  public write(
    deadline: number,
    now: () => number,
    publishedIds: string[],
    publish: (preview: TextPreview) => boolean,
  ): boolean {
    let stepped = false;
    for (const [id, preview] of this.#pending) {
      if (stepped && now() >= deadline) return true;
      const entry = this.mounted.get(id);
      const text = entry?.text;
      if (text?.prepare(preview.element, deadline, now) === false) return true;
      this.#pending.delete(id);
      if (entry !== undefined && (entry.displayedElement === preview.element || publish(preview)))
        publishedIds.push(id);
      stepped = true;
    }
    return false;
  }
}
