import type { SvgPathPart } from "../../domain/geometry/element-path";
import type { InkElementV1 } from "../../domain/schema/public";
import type { SceneContentRenderer } from "./content-renderer";
import { PATH_CACHE_MAX_BYTES } from "./constants";
import { ProgressivePreviewPath } from "./progressive-preview-path";

interface PreviewRequest {
  readonly ids: readonly string[];
  readonly materialize: (id: string) => InkElementV1 | undefined;
  readonly version: number;
}

interface CompletedPath {
  readonly element: InkElementV1;
  readonly parts: readonly SvgPathPart[];
}

interface PendingPath {
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
  readonly #maximumBytes: number;
  #completedBytes = 0;
  #request: PreviewRequest | undefined;
  #pending: PendingPath | undefined;
  #cursor = 0;

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
    }
    if (this.#pending !== undefined && !retained.has(this.#pending.element.id)) {
      this.#pending = undefined;
    }
    this.#request = request;
    for (const id of request.ids) this.#content.promoteVisible(id);
  }

  public write(deadline: number, now: () => number): boolean {
    // The fixed work cap also bounds fake clocks and unexpectedly cheap geometry.
    for (let step = 0; step < 8; step += 1) {
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
      this.#elements.set(pending.element.id, pending.element);
      const completed = { element: pending.element, parts: pending.path.parts! };
      this.#retainReplay(completed);
      this.#versions.set(pending.element.id, pending.version);
      this.#apply(completed);
      this.#pending = undefined;
      // Publishing a long path must not also allocate the next snapshot.
      if (longStroke) return this.#hasPending();
    }
    return this.#hasPending();
  }

  public applyMounted(ids: readonly string[]): void {
    for (const id of ids) {
      const completed = this.#completed.get(id);
      if (completed !== undefined) this.#apply(completed);
      else if (this.#elements.has(id)) this.#replayIds.add(id);
    }
  }

  public clear(): void {
    for (const id of this.#elements.keys()) this.#content.clearElementPreview(id);
    this.release();
  }

  public release(): void {
    this.#request = undefined;
    this.#pending = undefined;
    this.#cursor = 0;
    this.#elements.clear();
    this.#completed.clear();
    this.#replayIds.clear();
    this.#completedBytes = 0;
    this.#versions.clear();
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
        return { element, path: new ProgressivePreviewPath(element), version: request.version };
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
    this.#content.applyCanonicalElementPreview(completed.element, completed.parts);
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
