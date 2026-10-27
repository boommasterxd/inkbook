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
import type { ProgressivePreviewTransform } from "./progressive-preview-request";

interface PreviewRequest {
  readonly transformBounds: PreviewBoundsTransform | undefined;
  readonly strokeWidth: PreviewStrokeWidth;
  readonly transform: string | null;
  readonly matrix: PreviewTransform["matrix"];
  readonly feedback: ProgressivePreviewTransform | undefined;
  readonly version: number;
}

type PreviewContent = Pick<
  SceneContentRenderer,
  "applyPreviewTransform" | "flushSelectionContext" | "promoteVisible" | "previewMountedIds"
> &
  Partial<
    Pick<
      SceneContentRenderer,
      | "canUseSelectionFeedback"
      | "selectionFeedbackIds"
      | "selectionFeedbackExceptionIds"
      | "publishSelectionFeedback"
      | "clearSelectionFeedback"
      | "refreshSelectionFeedbackZoom"
    >
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
  #shared = false;
  #sharedDirty = false;
  #localIds: readonly string[] = [];

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
    affine?: PreviewTransform["matrix"] | ProgressivePreviewTransform,
  ): void {
    const feedback = affine !== undefined && "transform" in affine ? affine : undefined;
    this.#preview = {
      strokeWidth,
      transform,
      version,
      transformBounds,
      matrix: feedback === undefined ? (affine as PreviewTransform["matrix"]) : feedback.matrix,
      feedback,
    };
    if (this.canShare(this.#preview)) {
      this.#shared = true;
      this.#sharedDirty = true;
      this.#source = ids;
      this.#ids = this.#content.selectionFeedbackIds?.(feedback) ?? ids;
      this.#contextDirty = false;
      return;
    }
    if (this.#shared) {
      this.clearLocalTransforms();
      this.#content.clearSelectionFeedback?.();
      this.#shared = false;
      this.#sharedDirty = false;
      this.#source = undefined;
      this.#ids = [];
    }
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
    if (this.#shared) {
      this.#content.refreshSelectionFeedbackZoom?.();
      this.#contextDirty = false;
      return;
    }
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
    this.clearLocalTransforms();
    if (this.#shared) this.#content.clearSelectionFeedback?.();
    this.#shared = false;
    this.#sharedDirty = false;
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
    const request = this.#preview;
    if (this.#shared && request?.feedback !== undefined) {
      if (!this.#sharedDirty) return;
      if (this.#content.publishSelectionFeedback?.(request.feedback, request.version)) {
        const resolved = this.resolvePreview(request);
        // A common left translation preserves grouped members' existing local bases.
        this.#localIds = this.#content.selectionFeedbackExceptionIds?.(request.feedback) ?? [];
        for (const id of this.#localIds) this.applyTransform(id, resolved);
        this.#sharedDirty = false;
        return;
      }
      this.#shared = false;
      this.clearLocalTransforms();
      this.#content.clearSelectionFeedback?.();
      this.#ids = [];
      this.replaceSelection(this.#source!, request.version);
      const resolved = this.resolvePreview(request);
      for (const id of this.#ids) {
        this.setTransform(id, resolved);
        this.#dirty.add(id);
        this.#content.promoteVisible(id);
      }
    }
    for (const id of this.#dirty) {
      const preview = this.#transforms.get(id);
      if (preview !== undefined) {
        this.applyTransform(id, preview);
        if (preview.transform === null) this.removeTransform(id);
      }
    }
    this.#dirty.clear();
  }

  public release(): void {
    this.#localIds = [];
    this.#shared = false;
    this.#sharedDirty = false;
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
    if (this.#shared) {
      const preview = this.resolvePreview(this.#preview);
      for (const id of ids) {
        if (this.#localIds.includes(id)) this.applyTransform(id, preview);
      }
      return;
    }
    const additions = ids.filter((id) => this.#candidates.includes(id) && !this.#active.has(id));
    if (additions.length === 0) return;
    this.#ids = [...this.#ids, ...additions];
    const preview = this.resolvePreview(this.#preview);
    for (const id of additions) {
      this.#active.add(id);
      this.setTransform(id, preview);
      this.applyTransform(id, preview);
    }
  }

  private applyTransform(id: string, preview: PreviewTransform): void {
    const args = [id, preview.transform, preview.version, preview.strokeWidthScale] as const;
    if (preview.transform !== null && preview.matrix !== undefined)
      this.#content.applyPreviewTransform(...args, preview.matrix);
    else this.#content.applyPreviewTransform(...args);
  }

  private canShare(preview: PreviewRequest): boolean {
    const matrix = preview.feedback?.matrix;
    return (
      preview.strokeWidth === "scale" &&
      preview.transform !== null &&
      matrix?.[0] === 1 &&
      matrix[1] === 0 &&
      matrix[2] === 0 &&
      matrix[3] === 1 &&
      this.#transforms.size === 0 &&
      this.#content.canUseSelectionFeedback?.(preview.feedback) === true
    );
  }

  private clearLocalTransforms(): void {
    for (const id of this.#localIds)
      this.#content.applyPreviewTransform(id, null, Number.MAX_SAFE_INTEGER, null);
    this.#localIds = [];
  }

  private replaceSelection(ids: readonly string[], version: number): void {
    for (const id of this.#ids) {
      this.setTransform(id, {
        strokeWidthScale: null,
        transform: null,
        version,
      });
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
      matrix: preview.matrix?.every(Number.isFinite) ? preview.matrix : undefined,
      version: preview.version,
    };
  }
}
