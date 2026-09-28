import type { SceneContentRenderer } from "./content-renderer";
import { SceneResourcePolicy, visibilityPageBounds } from "./scene-resource-policy";
import type {
  MutableSceneInstrumentation,
  SceneCamera,
  SceneRendererOptions,
  SceneViewport,
} from "./types";
import type { SceneVisibilityState } from "./visibility-state";
import type { SceneTransformPreviewController } from "./transform-preview-controller";
import type { SceneElementPreviews } from "./scene-element-previews";
import { sameViewport, validateViewport } from "./scene-runtime";

export class SceneVisibilityCoordinator {
  readonly #content: SceneContentRenderer;
  readonly #resources: SceneResourcePolicy;
  readonly #visibility: SceneVisibilityState;
  readonly #transforms: SceneTransformPreviewController;
  readonly #elements: SceneElementPreviews;
  #dirty = true;
  #orderDirty = false;
  #queryPending = false;

  public get hasPendingQuery(): boolean {
    return this.#queryPending;
  }

  public constructor(
    content: SceneContentRenderer,
    visibility: SceneVisibilityState,
    resources: SceneResourcePolicy,
    transforms: SceneTransformPreviewController,
    elements: SceneElementPreviews,
  ) {
    this.#content = content;
    this.#visibility = visibility;
    this.#resources = resources;
    this.#transforms = transforms;
    this.#elements = elements;
  }

  /** Camera changes defer cancellation until the next visibility query proves a new target. */
  public invalidate(preservePending = false): void {
    this.#dirty = true;
    if (!preservePending) {
      this.#content.cancelPendingVisibility();
    }
  }

  public invalidateOrder(): void {
    this.#orderDirty = true;
  }

  public releasePreviews(): void {
    this.invalidate();
    this.#content.replaceVisibility(this.#visibility.resortCurrent(), !this.#orderDirty);
  }

  public releaseLostPreviews(
    ...args: Parameters<SceneContentRenderer["hasUnprotectedDeferredExit"]>
  ): void {
    if (this.#content.hasUnprotectedDeferredExit(...args)) this.releasePreviews();
  }

  public readViewport(
    layout: SceneRendererOptions["layout"],
    previous: SceneViewport | undefined,
    camera: SceneCamera,
    instrumentation: MutableSceneInstrumentation,
  ): SceneViewport {
    const viewport = layout.readViewport();
    instrumentation.layoutReads += 1;
    validateViewport(viewport);
    if (!sameViewport(previous, viewport)) this.setContext(camera, viewport);
    return viewport;
  }

  public setContext(camera: SceneCamera, viewport: SceneViewport | undefined): void {
    this.#transforms.setContext(camera, viewport);
    this.#elements.refreshProgressiveContext(viewport, camera);
    this.invalidate(true);
  }

  public prepare(
    viewport: SceneViewport | undefined,
    camera: SceneCamera,
    deadline = Infinity,
    now: () => number = () => 0,
  ): void {
    if (viewport === undefined) return;
    if (!this.#dirty) {
      if (this.#orderDirty) {
        this.#orderDirty = false;
        const visibility = this.#visibility.resortCurrent();
        this.#content.replaceVisibility(visibility);
        this.#resources.updateVisibility(visibility);
      }
      return;
    }
    const { envelope, retained } = visibilityPageBounds(viewport, camera);
    const orderDirty = this.#orderDirty;
    const progressive = !orderDirty;
    this.#dirty = false;
    this.#orderDirty = false;
    const result = this.#visibility.query(
      envelope,
      retained,
      !orderDirty && !this.#content.hasVisibilityWork && !this.#content.needsVisibilityRestart,
      deadline,
      now,
    );
    this.#queryPending = result.pending === true;
    if (this.#queryPending) {
      this.#dirty = true;
      return;
    }
    if (!result.changed && !orderDirty && !this.#content.needsVisibilityRestart) return;
    const visibility =
      !result.changed && orderDirty ? this.#visibility.resortCurrent() : result.visibility;
    this.#content.replaceVisibility(visibility, progressive, result.delta);
    this.#resources.updateVisibility(visibility);
  }
}
