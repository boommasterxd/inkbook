import type { PreviewTransform } from "../reconciliation/scene-visibility-reconciler";
import type { InkElementV1 } from "../../../domain/schema/public";
import type { SceneContentRenderer } from "../content-renderer";
import { SceneElementPreviewController } from "./element-preview-controller";
import { ProgressiveElementPreview } from "./progressive-element-preview";
import { ViewportPreviewSelection } from "./preview-transform-selection";
import type { SceneCamera, SceneStorePort, SceneViewport } from "../types";
import type { Bounds } from "../../../domain/geometry/public";

/** Owns synchronous and progressive previews under the same commit/cancel lifetime. */
export class SceneElementPreviews {
  public readonly immediate: SceneElementPreviewController;
  public readonly progressive: ProgressiveElementPreview;
  readonly #store: SceneStorePort;
  readonly #candidates = new ViewportPreviewSelection();
  #snapshotSource: readonly string[] | undefined;
  #snapshots: readonly string[] = [];
  #envelope: Bounds | undefined;
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
    const selected = this.#candidates.select(
      ids,
      this.content.previewMountedIds({
        transformBounds: this.#request?.feedback?.transformBounds,
        envelope: this.#envelope,
      }),
    );
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

  public refreshProgressiveContext(
    viewport: SceneViewport | undefined,
    camera: SceneCamera,
    envelope = this.#envelope,
    membershipChanged = false,
  ): void {
    this.#envelope = envelope;
    if (membershipChanged) this.#selection = undefined;
    const request = this.#request;
    if (request === undefined) return;
    const ids = this.selectProgressiveIds(request.ids, viewport, camera);
    this.progressive.set({
      ...request,
      ids: this.snapshotIds(ids),
      feedbackIds: ids,
      isImmediate: this.#isImmediate,
      affineElement: request.feedback === undefined ? undefined : this.#affineElement,
    });
  }

  private snapshotIds(ids: readonly string[]): readonly string[] {
    if (ids === this.#snapshotSource) return this.#snapshots;
    const snapshots: string[] = [];
    let paths = 0;
    for (const id of ids) {
      const element = this.#store.get(id)?.element;
      if (element === undefined) continue;
      const cost =
        element.kind === "arrow"
          ? 1 + Number(isFilledNode(element.startNode)) + Number(isFilledNode(element.endNode))
          : 1;
      if (paths + cost > 256) break;
      snapshots.push(id);
      paths += cost;
    }
    this.#snapshotSource = ids;
    this.#snapshots = snapshots;
    return snapshots;
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
    this.#snapshotSource = undefined;
    this.#snapshots = [];
    this.#candidates.clear();
    this.progressive.clear();
  }

  public memoryUsage(): number {
    return (
      this.#candidates.memoryUsage() +
      this.#snapshots.length * 8 +
      this.progressive.memoryUsage() +
      this.content.previewMemoryUsage()
    );
  }

  public get values(): ReadonlyMap<string, InkElementV1> {
    if (this.progressive.values.size === 0) return this.immediate.values;
    return new Map([...this.immediate.values, ...this.progressive.values]);
  }

  public retainCommittedGeometry(previews: ReadonlyMap<string, PreviewTransform>): void {
    this.content.materializePreviewGeometry(this.previewTransforms(previews), this.values);
  }

  public previewTransforms(
    previews: ReadonlyMap<string, PreviewTransform>,
  ): ReadonlyMap<string, PreviewTransform> {
    if (this.progressive.transforms.size === 0) return previews;
    if (previews.size === 0) return this.progressive.transforms;
    const transforms = new Map(previews);
    for (const [id, preview] of this.progressive.transforms) transforms.set(id, preview);
    return transforms;
  }

  public clear(): void {
    this.immediate.clear();
    this.clearProgressive();
  }

  public release(): void {
    this.#request = undefined;
    this.#selection = undefined;
    this.#snapshotSource = undefined;
    this.#snapshots = [];
    this.#candidates.clear();
    this.immediate.release();
    this.progressive.release();
  }

  public applyMounted(ids: readonly string[]): void {
    this.immediate.applyMounted(ids);
    if (this.#request !== undefined && ids.some((id) => this.#candidates.includes(id))) {
      const selection = this.#selection;
      if (selection !== undefined) {
        this.#selection = undefined;
        this.refreshProgressiveContext(selection.viewport, selection.camera);
      }
    }
    this.progressive.applyMounted(ids);
  }
}

function isFilledNode(node: string): boolean {
  return node === "triangle" || node === "diamond" || node === "circle";
}
