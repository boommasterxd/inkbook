import type { SceneContentRenderer } from "./content-renderer";
import { selectViewportNearPreviewIds } from "./preview-transform-selection";
import type { PreviewTransform } from "./scene-visibility-reconciler";
import type { PreviewStrokeWidth, SceneCamera, SceneStorePort, SceneViewport } from "./types";

interface PreviewRequest {
  readonly strokeWidth: PreviewStrokeWidth;
  readonly transform: string | null;
  readonly version: number;
}

export class SceneTransformPreviewController {
  readonly #content: SceneContentRenderer;
  readonly #dirty = new Set<string>();
  readonly #store: SceneStorePort;
  readonly #transforms = new Map<string, PreviewTransform>();
  #camera: SceneCamera;
  #ids: readonly string[] = [];
  #contextDirty = false;
  #preview: PreviewRequest | undefined;
  #source: readonly string[] | undefined;
  #viewport: SceneViewport | undefined;

  public constructor(content: SceneContentRenderer, store: SceneStorePort, camera: SceneCamera) {
    this.#content = content;
    this.#store = store;
    this.#camera = camera;
  }

  public get values(): ReadonlyMap<string, PreviewTransform> {
    return this.#transforms;
  }

  public get activeIds(): readonly string[] {
    return this.#ids;
  }

  public setContext(camera: SceneCamera, viewport: SceneViewport | undefined): void {
    this.#camera = camera;
    this.#viewport = viewport;
    this.#contextDirty = true;
    this.#content.setSelectionContext({ camera, viewport });
  }

  public set(
    ids: readonly string[],
    transform: string | null,
    version: number,
    strokeWidth: PreviewStrokeWidth,
  ): void {
    if (ids !== this.#source || this.#contextDirty) this.replaceSelection(ids, version);
    this.#preview = { strokeWidth, transform, version };
    const preview = this.resolvePreview(this.#preview);
    for (const id of this.#ids) {
      this.#transforms.set(id, preview);
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
    const resolved = this.resolvePreview(preview);
    for (const id of this.#ids) {
      this.#transforms.set(id, resolved);
      this.#dirty.add(id);
      this.#content.promoteVisible(id);
    }
    this.#contextDirty = false;
  }

  public clear(): void {
    for (const id of this.#transforms.keys()) {
      this.#transforms.set(id, {
        strokeWidthScale: null,
        transform: null,
        version: Number.MAX_SAFE_INTEGER,
      });
      this.#dirty.add(id);
    }
    this.#ids = [];
    this.#contextDirty = false;
    this.#preview = undefined;
    this.#source = undefined;
  }

  public write(): void {
    this.#content.flushSelectionContext();
    for (const id of this.#dirty) {
      const preview = this.#transforms.get(id);
      if (preview !== undefined) {
        this.#content.applyPreviewTransform(
          id,
          preview.transform,
          preview.version,
          preview.strokeWidthScale,
        );
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
      this.#transforms.set(id, { strokeWidthScale: null, transform: null, version });
      this.#dirty.add(id);
    }
    this.#ids = selectViewportNearPreviewIds(ids, this.#store, this.#viewport, this.#camera);
    this.#source = ids;
  }

  private resolvePreview(preview: PreviewRequest): PreviewTransform {
    return {
      strokeWidthScale: preview.strokeWidth === "preserve" ? this.#camera.zoom : null,
      transform: preview.transform,
      version: preview.version,
    };
  }
}
