import type { SceneContentRenderer } from "./content-renderer";
import { selectViewportNearPreviewIds } from "./preview-transform-selection";
import type { SceneCamera, SceneStorePort, SceneViewport } from "./types";
import type { SceneVisibilityState } from "./visibility-state";

interface PreviewTransform {
  readonly transform: string | null;
  readonly version: number;
}

export class SceneTransformPreviewController {
  readonly #content: SceneContentRenderer;
  readonly #dirty = new Set<string>();
  readonly #store: SceneStorePort;
  readonly #transforms = new Map<string, PreviewTransform>();
  readonly #visibility: SceneVisibilityState;
  #camera: SceneCamera;
  #ids: readonly string[] = [];
  #contextDirty = false;
  #preview: PreviewTransform | undefined;
  #source: readonly string[] | undefined;
  #viewport: SceneViewport | undefined;

  public constructor(
    content: SceneContentRenderer,
    store: SceneStorePort,
    visibility: SceneVisibilityState,
    camera: SceneCamera,
  ) {
    this.#content = content;
    this.#store = store;
    this.#visibility = visibility;
    this.#camera = camera;
  }

  public get values(): ReadonlyMap<string, PreviewTransform> {
    return this.#transforms;
  }

  public setContext(camera: SceneCamera, viewport: SceneViewport | undefined): void {
    this.#camera = camera;
    this.#viewport = viewport;
    this.#contextDirty = true;
  }

  public set(ids: readonly string[], transform: string | null, version: number): void {
    if (ids !== this.#source || this.#contextDirty) this.replaceSelection(ids, version);
    this.#preview = { transform, version };
    for (const id of this.#ids) {
      this.#transforms.set(id, this.#preview);
      this.#dirty.add(id);
      this.#content.promoteVisible(id);
    }
    this.#contextDirty = false;
  }

  public refreshContext(): void {
    if (!this.#contextDirty || this.#source === undefined) return;
    const preview = this.#preview;
    if (preview === undefined) return;
    this.replaceSelection(this.#source, preview.version);
    for (const id of this.#ids) {
      this.#transforms.set(id, preview);
      this.#dirty.add(id);
      this.#content.promoteVisible(id);
    }
    this.#contextDirty = false;
  }

  public clear(): void {
    for (const id of this.#transforms.keys()) {
      this.#transforms.set(id, { transform: null, version: Number.MAX_SAFE_INTEGER });
      this.#dirty.add(id);
    }
    this.#ids = [];
    this.#contextDirty = false;
    this.#preview = undefined;
    this.#source = undefined;
  }

  public write(): void {
    for (const id of this.#dirty) {
      const preview = this.#transforms.get(id);
      if (preview !== undefined) {
        this.#content.applyPreviewTransform(id, preview.transform, preview.version);
      }
    }
    this.#dirty.clear();
  }

  public release(): void {
    this.#dirty.clear();
    this.#transforms.clear();
    this.#ids = [];
    this.#contextDirty = false;
    this.#preview = undefined;
    this.#source = undefined;
  }

  private replaceSelection(ids: readonly string[], version: number): void {
    for (const id of this.#ids) {
      this.#transforms.set(id, { transform: null, version });
      this.#dirty.add(id);
    }
    this.#ids = selectViewportNearPreviewIds(
      ids,
      this.#store,
      this.#visibility,
      this.#viewport,
      this.#camera,
    );
    this.#source = ids;
  }
}
