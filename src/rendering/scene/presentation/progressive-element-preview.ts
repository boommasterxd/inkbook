import { strokeLocalGeometry } from "../../../domain/geometry/stroke-position";
import { buildElementPathParts } from "../../../domain/geometry/element-path";
import type { InkElementV1 } from "../../../domain/schema/public";
import type { SceneContentRenderer } from "../content-renderer";
import type { PreviewTransform } from "../reconciliation/scene-visibility-reconciler";
import { PATH_CACHE_MAX_BYTES } from "../constants";
import { ProgressivePreviewPath } from "../content/progressive-preview-path";
import { elementBytes, pathBytes, feedbackBytes, transformBytes } from "./preview-memory";

import type { PreviewRequest, ProgressivePreviewTransform } from "./progressive-preview-request";
import type { CompletedPath, PendingPath } from "./progressive-preview-request";
import { refreshPressureSnapshot } from "./progressive-pressure-snapshot";
export type { ProgressivePreviewTransform } from "./progressive-preview-request";

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
  #remainingConnected = 0;
  #replacement: Generator<void> | undefined;
  #replacementBytes = 0;

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
    bytes +=
      this.#membershipBytes + this.#feedbackBytes + this.#transformBytes + this.#replacementBytes;
    if (this.#pending !== undefined) bytes += elementBytes(this.#pending.element);
    return bytes + this.#elementBytes;
  }

  public set(request: PreviewRequest): void {
    if (this.#reuseConnected(request)) return;
    if (request.connected) {
      if (this.#pending !== undefined) this.#versions.delete(this.#pending.element.id);
      this.#pending?.path.cancel();
      this.#pending = undefined;
      this.#request = request;
      this.#remainingConnected = request.ids.length;
      this.#replacementBytes = 0;
      this.#replacement = this.#replace(request);
    } else {
      this.#replacement = undefined;
      this.#replacementBytes = 0;
      for (const step of this.#replace(request)) void step;
    }
  }

  *#replace(request: PreviewRequest): Generator<void> {
    const retained = new Set<string>();
    for (const id of request.ids) {
      retained.add(id);
      this.#replacementBytes += 32 + id.length * 2;
      yield;
    }
    const feedbackIds = request.feedbackIds ?? request.ids;
    if (feedbackIds !== this.#feedbackSource) {
      this.#feedbackSource = feedbackIds;
      this.#feedbackMembers.clear();
      this.#membershipBytes = 0;
      for (const id of feedbackIds) {
        if (this.#feedbackMembers.has(id)) continue;
        this.#feedbackMembers.add(id);
        this.#membershipBytes += 32 + id.length * 2;
        yield;
      }
    }
    for (const id of this.#feedbackIds) {
      if (!this.#feedbackMembers.has(id)) this.#clearFeedback(id);
      yield;
    }
    for (const id of this.#versions.keys()) {
      if (!retained.has(id)) {
        this.#versions.delete(id);
        this.#replayIds.delete(id);
      }
      yield;
    }
    for (const id of this.#elements.keys()) {
      if (retained.has(id)) {
        yield;
        continue;
      }
      this.#content.clearElementPreview(id);
      this.#setElement(id, undefined);
      this.#removeReplay(id);
      this.#versions.delete(id);
      this.#setFeedback(this.#snapshotFeedback, id, undefined);
      this.#setFeedback(this.#renderedFeedback, id, undefined);
      yield;
    }
    if (this.#pending !== undefined && !retained.has(this.#pending.element.id)) {
      this.#pending?.path.cancel();
      this.#pending = undefined;
    }
    if (!request.connected) this.#request = request;
    for (const id of request.ids) {
      const affine = request.affineElement?.(id);
      if (affine !== undefined) this.#retainAffine(affine, request.version);
      this.#content.promoteVisible(id);
      yield;
    }
    this.#replacementBytes = 0;
  }

  #reuseConnected(request: PreviewRequest): boolean {
    if (!request.connected) return false;
    if (
      this.#request?.connected &&
      this.#request.ids === request.ids &&
      this.#request.version === request.version
    )
      return true;
    this.#remainingConnected = 0;
    if (!this.#request?.connected || this.#request.ids !== request.ids) return false;
    this.#remainingConnected = request.ids.length;
    if (this.#pending !== undefined && !this.#pending.replay) this.#cursor -= 1;
    this.#pending?.path.cancel();
    this.#pending = undefined;
    this.#request = request;
    return true;
  }

  public writeFeedback(zoom: number, deadline: number, now: () => number): void {
    const request = this.#request;
    if (request?.connected && request.feedback === undefined) return;
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
      if (this.#replacement !== undefined) {
        const next = this.#replacement.next();
        stepped = true;
        if (next.done) this.#replacement = undefined;
        continue;
      }
      const refreshed = this.#refreshPressureSnapshot();
      if (refreshed && now() >= deadline) return this.#hasPending();
      const starting = refreshed || this.#pending === undefined;
      const pending = this.#pending ?? this.#startNext(deadline, now);
      if (pending === false) return true;
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
    this.#replacement = undefined;
    this.#replacementBytes = 0;
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
    this.#remainingConnected = 0;
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
    const refreshed = refreshPressureSnapshot(pending, request);
    this.#versions.set(pending.element.id, request.version);
    this.#pending = refreshed;
    return true;
  }

  #startNext(deadline: number, now: () => number): PendingPath | false | undefined {
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
    if (request.connected && this.#remainingConnected === 0) return undefined;
    for (let scanned = 0; scanned < request.ids.length; scanned += 1) {
      if (request.connected && this.#remainingConnected <= 0) return undefined;
      const id = request.ids[this.#cursor % request.ids.length]!;
      this.#cursor += 1;
      if (request.connected) this.#remainingConnected -= 1;
      if (this.#versions.get(id) === request.version) {
        if (request.connected && now() >= deadline) return false;
        continue;
      }
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
      if (request.connected && now() >= deadline) return false;
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
      this.#replacement !== undefined ||
      this.#replayIds.size > 0 ||
      (this.#request?.connected
        ? this.#remainingConnected > 0
        : (this.#request?.ids.some((id) => this.#versions.get(id) !== this.#request?.version) ??
          false))
    );
  }
}
