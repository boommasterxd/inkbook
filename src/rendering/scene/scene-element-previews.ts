import type { PreviewTransform } from "./scene-visibility-reconciler";
import type { InkElementV1 } from "../../domain/schema/public";
import type { SceneContentRenderer } from "./content-renderer";
import { SceneElementPreviewController } from "./element-preview-controller";
import { ProgressiveElementPreview } from "./progressive-element-preview";
import { ViewportPreviewSelection } from "./preview-transform-selection";
import type { SceneCamera, SceneStorePort, SceneViewport } from "./types";

/** Owns synchronous and progressive previews under the same commit/cancel lifetime. */
export class SceneElementPreviews {
  public readonly immediate: SceneElementPreviewController;
  public readonly progressive: ProgressiveElementPreview;
  readonly #store: SceneStorePort;
  readonly #candidates = new ViewportPreviewSelection();
  #request: Parameters<ProgressiveElementPreview["set"]>[0] | undefined;
  #selection:
    | {
        readonly camera: SceneCamera;
        readonly ids: readonly string[];
        readonly selected: readonly string[];
        readonly viewport: SceneViewport | undefined;
      }
    | undefined;

  public constructor(
    private readonly content: SceneContentRenderer,
    store: SceneStorePort,
  ) {
    this.#store = store;
    this.immediate = new SceneElementPreviewController(content);
    this.progressive = new ProgressiveElementPreview(content);
  }

  public selectProgressiveIds(
    ids: readonly string[],
    viewport: SceneViewport | undefined,
    camera: SceneCamera,
  ): readonly string[] {
    const previous = this.#selection;
    if (previous?.ids === ids && previous.viewport === viewport && previous.camera === camera) {
      return previous.selected;
    }
    const selected = this.#candidates.select(ids, this.#store, viewport, camera);
    this.#selection = { camera, ids, selected, viewport };
    return selected;
  }

  public setProgressive(
    request: Parameters<ProgressiveElementPreview["set"]>[0],
    viewport: SceneViewport | undefined,
    camera: SceneCamera,
  ): void {
    this.#request = request;
    this.refreshProgressiveContext(viewport, camera);
  }

  public refreshProgressiveContext(viewport: SceneViewport | undefined, camera: SceneCamera): void {
    const request = this.#request;
    if (request === undefined) return;
    const ids = this.selectProgressiveIds(request.ids, viewport, camera);
    this.progressive.set({
      ...request,
      ids,
      isImmediate: this.#isImmediate,
      affineElement: request.feedback === undefined ? undefined : this.#affineElement,
    });
  }

  readonly #affineElement = (id: string): InkElementV1 | undefined => {
    const element = this.#store.get(id)?.element;
    return element?.kind === "stroke" && !element.style.pressureEnabled ? element : undefined;
  };

  readonly #isImmediate = (id: string): boolean => {
    const element = this.#store.get(id)?.element;
    return element !== undefined && element.kind !== "stroke";
  };

  public clearProgressive(): void {
    this.#request = undefined;
    this.#selection = undefined;
    this.#candidates.clear();
    this.progressive.clear();
  }

  public memoryUsage(): number {
    return (
      this.#candidates.memoryUsage() +
      this.progressive.memoryUsage() +
      this.content.previewMemoryUsage()
    );
  }

  public get values(): ReadonlyMap<string, InkElementV1> {
    if (this.progressive.values.size === 0) return this.immediate.values;
    return new Map([...this.immediate.values, ...this.progressive.values]);
  }

  public retainCommittedGeometry(previews: ReadonlyMap<string, PreviewTransform>): void {
    this.content.materializePreviewGeometry(previews, this.values);
  }

  public clear(): void {
    this.immediate.clear();
    this.clearProgressive();
  }

  public release(): void {
    this.#request = undefined;
    this.#selection = undefined;
    this.#candidates.clear();
    this.immediate.release();
    this.progressive.release();
  }

  public applyMounted(ids: readonly string[]): void {
    this.immediate.applyMounted(ids);
    this.progressive.applyMounted(ids);
  }
}
