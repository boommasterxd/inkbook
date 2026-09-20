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

  public invalidate(): void {
    this.#dirty = true;
    this.#content.cancelPendingVisibility();
  }

  public invalidateOrder(): void {
    this.#orderDirty = true;
  }

  public releasePreviews(): void {
    this.invalidate();
    this.#content.replaceVisibility(this.#visibility.resortCurrent());
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
    this.#dirty = false;
    this.#orderDirty = false;
    const result = this.#visibility.query(envelope, retained);
    if (!result.changed && !this.#content.needsVisibilityRestart) return;
    this.#content.replaceVisibility(result.visibility);
    this.#resources.updateVisibility(result.visibility);
  }
}
