import { buildElementPathParts, type SvgPathPart } from "../../domain/geometry/element-path";
import type { InkElementV1 } from "../../domain/schema/public";
import type { SceneContentRenderer } from "./content-renderer";
import { PATH_CACHE_MAX_BYTES } from "./constants";
import { ProgressivePreviewPath } from "./progressive-preview-path";

const IMMEDIATE_ELEMENT_LIMIT = 64;
const PROGRESSIVE_STEPS_PER_FRAME = 4;

export interface ProgressivePreviewTransform {
  readonly transform: string;
  readonly inverse: string;
}

interface PreviewRequest {
  readonly feedback?: ProgressivePreviewTransform | undefined;
  readonly ids: readonly string[];
  readonly isImmediate?: (id: string) => boolean;
  readonly affineElement?: ((id: string) => InkElementV1 | undefined) | undefined;
  readonly materialize: (id: string) => InkElementV1 | undefined;
  readonly version: number;
}

interface CompletedPath {
  readonly feedback: ProgressivePreviewTransform | undefined;
  readonly element: InkElementV1;
  readonly parts: readonly SvgPathPart[];
}

interface PendingPath {
  readonly feedback: ProgressivePreviewTransform | undefined;
  readonly element: InkElementV1;
  readonly path: ProgressivePreviewPath;
  readonly version: number;
}

/** Retains complete canonical snapshots while coalescing updates to a bounded selection. */
export class ProgressiveElementPreview {
  readonly #content: SceneContentRenderer;
  readonly #elements = new Map<string, InkElementV1>();
  readonly #completed = new Map<string, CompletedPath>();
  readonly #versions = new Map<string, number>();
  readonly #replayIds = new Set<string>();
  readonly #feedbackIds = new Set<string>();
  readonly #snapshotFeedback = new Map<string, ProgressivePreviewTransform>();
  readonly #renderedFeedback = new Map<string, ProgressivePreviewTransform>();
  #zoom = 1;
  readonly #maximumBytes: number;
  #completedBytes = 0;
  #request: PreviewRequest | undefined;
  #appliedRequest: PreviewRequest | undefined;
  #pending: PendingPath | undefined;
  #cursor = 0;
  #immediateCursor = 0;

  public constructor(content: SceneContentRenderer, maximumBytes = PATH_CACHE_MAX_BYTES) {
    this.#content = content;
    this.#maximumBytes = maximumBytes;
  }

  public get values(): ReadonlyMap<string, InkElementV1> {
    return this.#elements;
  }

  public memoryUsage(): number {
    let bytes = this.#completedBytes + (this.#pending?.path.memoryUsage() ?? 0);
    if (this.#pending !== undefined) bytes += elementBytes(this.#pending.element);
    for (const element of this.#elements.values()) bytes += elementBytes(element);
    return bytes;
  }

  public set(request: PreviewRequest): void {
    request = { ...request, ids: request.ids.slice(0, 256) };
    const retained = new Set(request.ids);
    for (const id of this.#feedbackIds) {
      if (!retained.has(id)) this.#clearFeedback(id);
    }
    for (const id of this.#versions.keys()) {
      if (!retained.has(id)) {
        this.#versions.delete(id);
        this.#replayIds.delete(id);
      }
    }
    for (const id of this.#elements.keys()) {
      if (retained.has(id)) continue;
      this.#content.clearElementPreview(id);
      this.#elements.delete(id);
      this.#removeReplay(id);
      this.#versions.delete(id);
      this.#snapshotFeedback.delete(id);
      this.#renderedFeedback.delete(id);
    }
    if (this.#pending !== undefined && !retained.has(this.#pending.element.id)) {
      this.#pending = undefined;
    }
    this.#request = request;
    for (const id of request.ids) {
      const affine = request.affineElement?.(id);
      if (affine !== undefined) this.#retainAffine(affine, request.version);
      this.#content.promoteVisible(id);
    }
  }

  public writeFeedback(zoom: number): void {
    const request = this.#request;
    if (request === undefined || (request === this.#appliedRequest && zoom === this.#zoom)) return;
    this.#zoom = zoom;
    this.#appliedRequest = request;
    let immediate = 0;
    const start = this.#immediateCursor;
    for (let offset = 0; offset < request.ids.length; offset += 1) {
      const index = (start + offset) % request.ids.length;
      const id = request.ids[index]!;
      if (immediate < IMMEDIATE_ELEMENT_LIMIT && this.#writeImmediate(id, request)) {
        immediate += 1;
        this.#immediateCursor = index + 1;
      } else this.#applyFeedback(id);
    }
  }

  public write(deadline: number, now: () => number): boolean {
    // Reserve frame time for residual feedback, immediate shapes, and scene writes.
    // The fixed work cap also bounds fake clocks and unexpectedly cheap geometry.
    for (let step = 0; step < PROGRESSIVE_STEPS_PER_FRAME; step += 1) {
      if (now() >= deadline) return this.#hasPending();
      const starting = this.#pending === undefined;
      const pending = this.#pending ?? this.#startNext();
      if (pending === undefined) return false;
      this.#pending = pending;
      const longStroke =
        pending.element.kind === "stroke" && pending.element.points.length > 256 * 3;
      // Materialization and center preparation consume their own frame budget.
      if (starting && longStroke) return true;
      if (!pending.path.step()) continue;
      this.#complete(
        { element: pending.element, feedback: pending.feedback, parts: pending.path.parts! },
        pending.version,
      );
      this.#pending = undefined;
      // Publishing a long path must not also allocate the next snapshot.
      if (longStroke) return this.#hasPending();
    }
    return this.#hasPending();
  }

  public applyMounted(ids: readonly string[]): void {
    for (const id of ids) {
      this.#renderedFeedback.delete(id);
      if (this.#request?.affineElement?.(id) !== undefined) {
        this.#applyFeedback(id);
        continue;
      }
      const completed = this.#completed.get(id);
      if (completed !== undefined) this.#apply(completed);
      else {
        if (this.#request?.isImmediate?.(id) && this.#elements.has(id)) {
          const element = this.#elements.get(id)!;
          this.#complete(
            {
              element,
              feedback: this.#snapshotFeedback.get(id),
              parts: buildElementPathParts(element),
            },
            this.#versions.get(id)!,
          );
          continue;
        }
        if (this.#elements.has(id)) this.#replayIds.add(id);
        if (this.#request?.ids.includes(id)) this.#applyFeedback(id);
      }
    }
  }

  public clear(): void {
    for (const id of this.#feedbackIds) this.#clearFeedback(id);
    for (const id of this.#elements.keys()) this.#content.clearElementPreview(id);
    this.release();
  }

  public release(): void {
    this.#feedbackIds.clear();
    this.#snapshotFeedback.clear();
    this.#renderedFeedback.clear();
    this.#request = undefined;
    this.#appliedRequest = undefined;
    this.#pending = undefined;
    this.#cursor = 0;
    this.#immediateCursor = 0;
    this.#elements.clear();
    this.#completed.clear();
    this.#replayIds.clear();
    this.#completedBytes = 0;
    this.#versions.clear();
  }

  #retainAffine(element: InkElementV1, version: number): void {
    const id = element.id;
    if (this.#elements.has(id) && this.#elements.get(id) !== element) {
      this.#content.clearElementPreview(id);
      this.#removeReplay(id);
      this.#snapshotFeedback.delete(id);
      this.#renderedFeedback.delete(id);
    }
    if (this.#pending?.element.id === id) this.#pending = undefined;
    this.#replayIds.delete(id);
    this.#elements.set(id, element);
    this.#versions.set(id, version);
  }

  #writeImmediate(id: string, request: PreviewRequest): boolean {
    if (!request.isImmediate?.(id) || this.#versions.get(id) === request.version) return false;
    const element = request.materialize(id);
    this.#versions.set(id, request.version);
    if (element === undefined) return false;
    this.#replayIds.delete(id);
    if (this.#pending?.element.id === id) this.#pending = undefined;
    this.#complete(
      { element, feedback: request.feedback, parts: buildElementPathParts(element) },
      request.version,
    );
    return true;
  }

  #complete(completed: CompletedPath, version: number): void {
    const id = completed.element.id;
    this.#elements.set(id, completed.element);
    if (completed.feedback !== undefined) this.#snapshotFeedback.set(id, completed.feedback);
    else this.#snapshotFeedback.delete(id);
    this.#retainReplay(completed);
    this.#versions.set(id, version);
    this.#apply(completed);
  }

  #startNext(): PendingPath | undefined {
    const request = this.#request;
    if (request === undefined) return undefined;
    const replayId = this.#replayIds.values().next().value;
    if (replayId !== undefined) {
      this.#replayIds.delete(replayId);
      const element = this.#elements.get(replayId)!;
      return {
        element,
        feedback: this.#snapshotFeedback.get(replayId),
        path: new ProgressivePreviewPath(element),
        version: this.#versions.get(replayId)!,
      };
    }
    for (let scanned = 0; scanned < request.ids.length; scanned += 1) {
      const id = request.ids[this.#cursor % request.ids.length]!;
      this.#cursor += 1;
      if (this.#versions.get(id) === request.version) continue;
      const element = request.materialize(id);
      this.#versions.set(id, request.version);
      if (element !== undefined) {
        return {
          element,
          feedback: request.feedback,
          path: new ProgressivePreviewPath(element),
          version: request.version,
        };
      }
    }
    return undefined;
  }

  #retainReplay(completed: CompletedPath): void {
    const id = completed.element.id;
    this.#removeReplay(id);
    this.#completed.set(id, completed);
    this.#completedBytes += pathBytes(completed.parts);
    while (this.#completedBytes > this.#maximumBytes) {
      const oldest = this.#completed.keys().next().value;
      if (oldest === undefined) break;
      this.#removeReplay(oldest);
    }
  }

  #removeReplay(id: string): void {
    const previous = this.#completed.get(id);
    if (previous === undefined) return;
    this.#completedBytes -= pathBytes(previous.parts);
    this.#completed.delete(id);
  }

  #apply(completed: CompletedPath): void {
    const id = completed.element.id;
    if (!this.#content.applyCanonicalElementPreview(completed.element, completed.parts)) return;
    if (completed.feedback !== undefined) this.#renderedFeedback.set(id, completed.feedback);
    else this.#renderedFeedback.delete(id);
    this.#applyFeedback(id);
  }

  #applyFeedback(id: string): void {
    const request = this.#request;
    const feedback = request?.feedback;
    if (feedback === undefined && !this.#feedbackIds.has(id)) return;
    const basis = this.#renderedFeedback.get(id);
    const transform =
      feedback === undefined || feedback.transform === basis?.transform
        ? null
        : `${feedback.transform}${basis === undefined ? "" : ` ${basis.inverse}`}`;
    this.#feedbackIds.add(id);
    this.#content.applyPreviewTransform(
      id,
      transform,
      request?.version ?? 0,
      transform === null ? null : this.#zoom,
    );
  }

  #clearFeedback(id: string): void {
    this.#content.applyPreviewTransform(id, null, Number.MAX_SAFE_INTEGER, null);
    this.#feedbackIds.delete(id);
    this.#renderedFeedback.delete(id);
  }

  #hasPending(): boolean {
    return (
      this.#pending !== undefined ||
      this.#replayIds.size > 0 ||
      (this.#request?.ids.some((id) => this.#versions.get(id) !== this.#request?.version) ?? false)
    );
  }
}

function elementBytes(element: InkElementV1): number {
  return 128 + (element.kind === "stroke" ? element.points.length * 8 : 0);
}

function pathBytes(parts: readonly SvgPathPart[]): number {
  return parts.reduce((bytes, part) => bytes + part.d.length * 2, 0);
}
