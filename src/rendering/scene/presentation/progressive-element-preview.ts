import { strokeLocalGeometry } from "../../../domain/geometry/stroke-position";
import { isStoredStroke } from "../../../domain/elements/stroke-replacement-proof";
import { sameLocalSelectionShape } from "../../../domain/store/records/prepared-stroke-center-cache";
import { buildElementPathParts, type SvgPathPart } from "../../../domain/geometry/element-path";
import type { InkElementV1, StrokeElementV1 } from "../../../domain/schema/public";
import type { SceneContentRenderer } from "../content-renderer";
import type { PreviewTransform } from "../reconciliation/scene-visibility-reconciler";
import type { PreviewBoundsTransform } from "../types";
import { PATH_CACHE_MAX_BYTES } from "../constants";
import { ProgressivePreviewPath } from "../content/progressive-preview-path";

export interface ProgressivePreviewTransform {
  readonly transformBounds?: PreviewBoundsTransform;
  readonly transform: string;
  readonly inverse: string;
}

interface PreviewRequest {
  readonly feedback?: ProgressivePreviewTransform | undefined;
  readonly ids: readonly string[];
  readonly feedbackIds?: readonly string[];
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
  readonly pressureEnabled: boolean;
  readonly replay?: boolean;
}

/** Retains complete canonical snapshots while coalescing updates to a bounded selection. */
export class ProgressiveElementPreview {
  readonly #content: SceneContentRenderer;
  readonly #elements = new Map<string, InkElementV1>();
  readonly #completed = new Map<string, CompletedPath>();
  readonly #versions = new Map<string, number>();
  readonly #replayIds = new Set<string>();
  readonly #feedbackIds = new Set<string>();
  readonly #transforms = new Map<string, PreviewTransform>();
  readonly #snapshotFeedback = new Map<string, ProgressivePreviewTransform>();
  readonly #renderedFeedback = new Map<string, ProgressivePreviewTransform>();
  readonly #feedbackMembers = new Set<string>();
  #feedbackSource: readonly string[] | undefined;
  #membershipBytes = 0;
  #elementBytes = 0;
  #feedbackBytes = 0;
  #transformBytes = 0;
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

  public get transforms(): ReadonlyMap<string, PreviewTransform> {
    return this.#transforms;
  }

  public get pending(): boolean {
    return this.#hasPending();
  }

  public memoryUsage(): number {
    let bytes = this.#completedBytes + (this.#pending?.path.memoryUsage() ?? 0);
    bytes += (this.#request?.ids.length ?? 0) * 8 + (this.#request?.feedbackIds?.length ?? 0) * 8;
    bytes += (this.#versions.size + this.#replayIds.size + this.#feedbackIds.size) * 40;
    bytes += this.#membershipBytes + this.#feedbackBytes + this.#transformBytes;
    if (this.#pending !== undefined) bytes += elementBytes(this.#pending.element);
    return bytes + this.#elementBytes;
  }

  public set(request: PreviewRequest): void {
    const retained = new Set(request.ids);
    const feedbackIds = request.feedbackIds ?? request.ids;
    if (feedbackIds !== this.#feedbackSource) {
      this.#feedbackSource = feedbackIds;
      this.#feedbackMembers.clear();
      this.#membershipBytes = 0;
      for (const id of feedbackIds) {
        if (this.#feedbackMembers.has(id)) continue;
        this.#feedbackMembers.add(id);
        this.#membershipBytes += 32 + id.length * 2;
      }
    }
    for (const id of this.#feedbackIds) {
      if (!this.#feedbackMembers.has(id)) this.#clearFeedback(id);
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
      this.#setElement(id, undefined);
      this.#removeReplay(id);
      this.#versions.delete(id);
      this.#setFeedback(this.#snapshotFeedback, id, undefined);
      this.#setFeedback(this.#renderedFeedback, id, undefined);
    }
    if (this.#pending !== undefined && !retained.has(this.#pending.element.id)) {
      this.#pending?.path.cancel();
      this.#pending = undefined;
    }
    this.#request = request;
    for (const id of request.ids) {
      const affine = request.affineElement?.(id);
      if (affine !== undefined) this.#retainAffine(affine, request.version);
      this.#content.promoteVisible(id);
    }
  }

  public writeFeedback(zoom: number, deadline: number, now: () => number): void {
    const request = this.#request;
    if (request === undefined || (request === this.#appliedRequest && zoom === this.#zoom)) return;
    this.#zoom = zoom;
    this.#appliedRequest = request;
    const start = this.#immediateCursor;
    const ids = request.feedbackIds ?? request.ids;
    const snapshots = new Set(request.ids);
    for (let offset = 0; offset < ids.length; offset += 1) {
      const index = (start + offset) % ids.length;
      const id = ids[index]!;
      if (snapshots.has(id) && now() < deadline && this.#writeImmediate(id, request))
        this.#immediateCursor = index + 1;
      else this.#applyFeedback(id);
    }
  }

  public write(deadline: number, now: () => number, admittedFirstStep = false): boolean {
    // An admitted late call may start one bounded unit; further work shares the frame deadline.
    let stepped = false;
    while (true) {
      if ((stepped || !admittedFirstStep) && now() >= deadline) return this.#hasPending();
      const refreshed = this.#refreshPressureSnapshot();
      if (refreshed && now() >= deadline) return this.#hasPending();
      const starting = refreshed || this.#pending === undefined;
      const pending = this.#pending ?? this.#startNext();
      if (pending === undefined) return false;
      this.#pending = pending;
      // Materialization itself can exhaust the budget before the next geometry unit.
      if (starting && now() >= deadline) return true;
      stepped = true;
      if (!pending.path.step(deadline, now)) continue;
      this.#complete(
        { element: pending.element, feedback: pending.feedback, parts: pending.path.parts! },
        pending.version,
      );
      this.#pending?.path.cancel();
      this.#pending = undefined;
    }
  }

  public applyMounted(ids: readonly string[]): void {
    for (const id of ids) {
      this.#setFeedback(this.#renderedFeedback, id, undefined);
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
              parts: buildElementPathParts(
                element.kind === "stroke" ? strokeLocalGeometry(element) : element,
              ),
            },
            this.#versions.get(id)!,
          );
          continue;
        }
        if (this.#elements.has(id)) this.#replayIds.add(id);
        if (this.#feedbackMembers.has(id)) this.#applyFeedback(id);
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
    this.#transforms.clear();
    this.#snapshotFeedback.clear();
    this.#renderedFeedback.clear();
    this.#feedbackMembers.clear();
    this.#feedbackSource = undefined;
    this.#membershipBytes = 0;
    this.#elementBytes = 0;
    this.#feedbackBytes = 0;
    this.#transformBytes = 0;
    this.#request = undefined;
    this.#appliedRequest = undefined;
    this.#pending?.path.cancel();
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
      this.#setFeedback(this.#snapshotFeedback, id, undefined);
      this.#setFeedback(this.#renderedFeedback, id, undefined);
    }
    if (this.#pending?.element.id === id) {
      this.#pending.path.cancel();
      this.#pending = undefined;
    }
    this.#replayIds.delete(id);
    this.#setElement(id, element);
    this.#versions.set(id, version);
  }

  #writeImmediate(id: string, request: PreviewRequest): boolean {
    if (!request.isImmediate?.(id) || this.#versions.get(id) === request.version) return false;
    const element = request.materialize(id);
    this.#versions.set(id, request.version);
    if (element === undefined) return false;
    this.#replayIds.delete(id);
    if (this.#pending?.element.id === id) {
      this.#pending.path.cancel();
      this.#pending = undefined;
    }
    this.#complete(
      {
        element,
        feedback: request.feedback,
        parts: buildElementPathParts(
          element.kind === "stroke" ? strokeLocalGeometry(element) : element,
        ),
      },
      request.version,
    );
    return true;
  }

  #complete(completed: CompletedPath, version: number): void {
    const id = completed.element.id;
    this.#setElement(id, completed.element);
    this.#setFeedback(this.#snapshotFeedback, id, completed.feedback);
    this.#retainReplay(completed);
    this.#versions.set(id, version);
    this.#apply(completed);
  }

  #refreshPressureSnapshot(): boolean {
    const pending = this.#pending;
    const request = this.#request;
    if (
      pending === undefined ||
      request?.feedback === undefined ||
      pending.replay ||
      pending.version === request.version ||
      !pending.pressureEnabled
    )
      return false;
    const element = request.materialize(pending.element.id);
    const reusable =
      pending.element.kind === "stroke" &&
      element?.kind === "stroke" &&
      immutableLocalShape(pending.element) &&
      immutableLocalShape(element) &&
      sameLocalSelectionShape(pending.element, element);
    if (!reusable) pending.path.cancel();
    this.#versions.set(pending.element.id, request.version);
    this.#pending =
      element === undefined
        ? undefined
        : {
            element,
            feedback: request.feedback,
            path: reusable ? pending.path : new ProgressivePreviewPath(element),
            version: request.version,
            pressureEnabled: element.kind === "stroke" && element.style.pressureEnabled,
          };
    return true;
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
        pressureEnabled: element.kind === "stroke" && element.style.pressureEnabled,
        replay: true,
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
          pressureEnabled: element.kind === "stroke" && element.style.pressureEnabled,
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
    this.#setFeedback(this.#renderedFeedback, id, completed.feedback);
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
    const preview = {
      transform,
      version: request?.version ?? 0,
      strokeWidthScale: transform === null ? null : this.#zoom,
    };
    this.#setTransform(id, transform === null ? undefined : preview);
    this.#content.applyPreviewTransform(
      id,
      preview.transform,
      preview.version,
      preview.strokeWidthScale,
    );
  }

  #clearFeedback(id: string): void {
    this.#content.applyPreviewTransform(id, null, Number.MAX_SAFE_INTEGER, null);
    this.#feedbackIds.delete(id);
    this.#setTransform(id, undefined);
    this.#setFeedback(this.#renderedFeedback, id, undefined);
  }

  #setElement(id: string, element: InkElementV1 | undefined): void {
    const previous = this.#elements.get(id);
    this.#elementBytes +=
      (element === undefined ? 0 : elementBytes(element)) -
      (previous === undefined ? 0 : elementBytes(previous));
    if (element === undefined) this.#elements.delete(id);
    else this.#elements.set(id, element);
  }

  #setFeedback(
    entries: Map<string, ProgressivePreviewTransform>,
    id: string,
    feedback: ProgressivePreviewTransform | undefined,
  ): void {
    const previous = entries.get(id);
    this.#feedbackBytes +=
      (feedback === undefined ? 0 : feedbackBytes(id, feedback)) -
      (previous === undefined ? 0 : feedbackBytes(id, previous));
    if (feedback === undefined) entries.delete(id);
    else entries.set(id, feedback);
  }

  #setTransform(id: string, preview: PreviewTransform | undefined): void {
    const previous = this.#transforms.get(id);
    this.#transformBytes +=
      (preview === undefined ? 0 : transformBytes(id, preview)) -
      (previous === undefined ? 0 : transformBytes(id, previous));
    if (preview === undefined) this.#transforms.delete(id);
    else this.#transforms.set(id, preview);
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

function immutableLocalShape(element: StrokeElementV1): boolean {
  return (
    isStoredStroke(element) ||
    (Object.isFrozen(element) &&
      Object.isFrozen(element.points) &&
      Object.isFrozen(element.style) &&
      Object.isFrozen(element.pivot) &&
      (element.offset === undefined || Object.isFrozen(element.offset)))
  );
}

function pathBytes(parts: readonly SvgPathPart[]): number {
  return parts.reduce((bytes, part) => bytes + part.d.length * 2, 0);
}

function feedbackBytes(id: string, feedback: ProgressivePreviewTransform): number {
  return 64 + (id.length + feedback.transform.length + feedback.inverse.length) * 2;
}

function transformBytes(id: string, preview: PreviewTransform): number {
  return 80 + (id.length + (preview.transform?.length ?? 0)) * 2;
}
