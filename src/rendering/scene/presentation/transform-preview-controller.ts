import type { SceneContentRenderer } from "../content-renderer";
import { ViewportPreviewSelection } from "./preview-transform-selection";
import type { PreviewTransform } from "../reconciliation/scene-visibility-reconciler";
import type {
  PreviewBoundsTransform,
  PreviewStrokeWidth,
  SceneCamera,
  SceneViewport,
} from "../types";
import type { Bounds } from "../../../domain/geometry/public";

interface PreviewRequest {
  readonly transformBounds: PreviewBoundsTransform | undefined;
  readonly strokeWidth: PreviewStrokeWidth;
  readonly transform: string | null;
  readonly version: number;
}

type PreviewContent = Pick<
  SceneContentRenderer,
  "applyPreviewTransform" | "flushSelectionContext" | "promoteVisible" | "previewMountedIds"
>;

export class SceneTransformPreviewController {
  readonly #content: PreviewContent;
  readonly #dirty = new Set<string>();
  readonly #active = new Set<string>();
  readonly #candidates = new ViewportPreviewSelection();
  readonly #transforms = new Map<string, PreviewTransform>();
  #transformBytes = 0;
  #camera: SceneCamera;
  #ids: readonly string[] = [];
  #contextDirty = false;
  #preview: PreviewRequest | undefined;
  #source: readonly string[] | undefined;
  #envelope: Bounds | undefined;

  public constructor(content: PreviewContent, camera: SceneCamera) {
    this.#content = content;
    this.#camera = camera;
  }

  public memoryUsage(): number {
    return (
      this.#candidates.memoryUsage() +
      this.#ids.length * 8 +
      (this.#dirty.size + this.#active.size) * 40 +
      this.#transformBytes
    );
  }

  public get values(): ReadonlyMap<string, PreviewTransform> {
    return this.#transforms;
  }

  public get activeIds(): readonly string[] {
    return this.#ids;
  }

  public setContext(
    camera: SceneCamera,
    _viewport: SceneViewport | undefined,
    envelope?: Bounds,
  ): void {
    this.#camera = camera;
    this.#envelope = envelope;
    this.#contextDirty = true;
  }

  public set(
    ids: readonly string[],
    transform: string | null,
    version: number,
    strokeWidth: PreviewStrokeWidth,
    transformBounds?: PreviewBoundsTransform,
  ): void {
    this.#preview = { strokeWidth, transform, version, transformBounds };
    if (ids !== this.#source || this.#contextDirty) this.replaceSelection(ids, version);
    const preview = this.resolvePreview(this.#preview);
    for (const id of this.#ids) {
      this.setTransform(id, preview);
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
      this.setTransform(id, resolved);
      this.#dirty.add(id);
      this.#content.promoteVisible(id);
    }
    this.#contextDirty = false;
  }

  public clear(): boolean {
    if (this.#source === undefined) return false;
    for (const id of this.#transforms.keys()) {
      this.setTransform(id, {
        strokeWidthScale: null,
        transform: null,
        version: Number.MAX_SAFE_INTEGER,
      });
      this.#dirty.add(id);
    }
    this.#ids = [];
    this.#active.clear();
    this.#contextDirty = false;
    this.#preview = undefined;
    this.#source = undefined;
    this.#candidates.clear();
    return true;
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
        if (preview.transform === null) this.removeTransform(id);
      }
    }
    this.#dirty.clear();
  }

  public release(): void {
    this.#dirty.clear();
    this.#transforms.clear();
    this.#transformBytes = 0;
    this.#ids = [];
    this.#active.clear();
    this.#contextDirty = false;
    this.#preview = undefined;
    this.#source = undefined;
    this.#candidates.clear();
  }

  public applyMounted(ids: readonly string[]): void {
    if (this.#preview === undefined) return;
    const additions = ids.filter((id) => this.#candidates.includes(id) && !this.#active.has(id));
    if (additions.length === 0) return;
    this.#ids = [...this.#ids, ...additions];
    const preview = this.resolvePreview(this.#preview);
    for (const id of additions) {
      this.#active.add(id);
      this.setTransform(id, preview);
      this.#content.applyPreviewTransform(
        id,
        preview.transform,
        preview.version,
        preview.strokeWidthScale,
      );
    }
  }

  private replaceSelection(ids: readonly string[], version: number): void {
    for (const id of this.#ids) {
      this.setTransform(id, { strokeWidthScale: null, transform: null, version });
      this.#dirty.add(id);
    }
    this.#ids = this.#candidates.select(
      ids,
      this.#content.previewMountedIds({
        transformBounds: this.#preview?.transformBounds,
        envelope: this.#envelope,
      }),
    );
    this.#active.clear();
    for (const id of this.#ids) this.#active.add(id);
    this.#source = ids;
  }

  private setTransform(id: string, preview: PreviewTransform): void {
    const previous = this.#transforms.get(id);
    this.#transformBytes +=
      (previous === undefined ? 80 + id.length * 2 : 0) +
      2 * ((preview.transform?.length ?? 0) - (previous?.transform?.length ?? 0));
    this.#transforms.set(id, preview);
  }

  private removeTransform(id: string): void {
    const previous = this.#transforms.get(id);
    if (previous === undefined) return;
    this.#transformBytes -= 80 + 2 * (id.length + (previous.transform?.length ?? 0));
    this.#transforms.delete(id);
  }

  private resolvePreview(preview: PreviewRequest): PreviewTransform {
    return {
      strokeWidthScale: preview.strokeWidth === "preserve" ? this.#camera.zoom : null,
      transform: preview.transform,
      version: preview.version,
    };
  }
}
