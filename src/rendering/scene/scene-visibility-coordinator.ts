import type { SceneContentRenderer } from "./content-renderer";
import { SceneResourcePolicy, visibilityPageBounds } from "./scene-resource-policy";
import type { SceneCamera, SceneViewport } from "./types";
import type { SceneVisibilityState } from "./visibility-state";

export class SceneVisibilityCoordinator {
  readonly #content: SceneContentRenderer;
  readonly #resources: SceneResourcePolicy;
  readonly #visibility: SceneVisibilityState;
  #dirty = true;
  #orderDirty = false;

  public constructor(
    content: SceneContentRenderer,
    visibility: SceneVisibilityState,
    resources: SceneResourcePolicy,
  ) {
    this.#content = content;
    this.#visibility = visibility;
    this.#resources = resources;
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

  public prepare(viewport: SceneViewport | undefined, camera: SceneCamera): void {
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
    const result = this.#visibility.query(envelope, retained);
    if (!result.changed && !orderDirty && !this.#content.needsVisibilityRestart) return;
    const visibility =
      !result.changed && orderDirty ? this.#visibility.resortCurrent() : result.visibility;
    this.#content.replaceVisibility(visibility, progressive);
    this.#resources.updateVisibility(visibility);
  }
}
