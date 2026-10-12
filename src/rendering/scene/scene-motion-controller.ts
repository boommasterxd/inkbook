import { FILE_SCHEMA_LIMITS, type InkElementV1 } from "../../domain/schema/public";
import { TRANSITION_DURATIONS } from "../motion/transitions";
import type { SceneContentRenderer } from "./content-renderer";
import { interpolateElement, standardMotionProgress } from "./motion-interpolation";
import {
  createMotionVisual,
  removeMotionVisual,
  writeMotionStyle,
  writeMotionVisual,
  type MotionVisual,
} from "./motion-visual";
import type {
  GeometryMotionEntry,
  MotionEntry,
  OverlayMotion,
  PendingSuppression,
} from "./scene-motion-types";
import type { SceneDom } from "./scene-dom";
import type { MutableSceneInstrumentation, SceneStoreDelta } from "./types";
const MAX_MOTION_PATHS = 256;
const MAX_MOTION_BYTES = 4 * 1024 * 1024;
export class SceneMotionController {
  readonly #content: SceneContentRenderer;
  readonly #dom: SceneDom;
  readonly #entries = new Map<number, MotionEntry>();
  #cacheBytes = 0;
  #cacheEntries = 0;
  #frameCursor: Iterator<MotionEntry> | undefined;
  readonly #entryByElementId = new Map<string, number>();
  readonly #instrumentation: MutableSceneInstrumentation;
  readonly #pendingEntrances = new Set<string>();
  #nextId = 0;
  #nextSuppressionToken = 0;
  #pendingSuppression: PendingSuppression | undefined;
  #lastFrameTime: number | undefined;
  #resourceConstrained = false;
  #reducedMotion: boolean;
  #selectionMotion: OverlayMotion | undefined;
  #lastSelectionFrameTime: number | undefined;
  #selectionHandleMotion: OverlayMotion | undefined;
  public constructor(
    dom: SceneDom,
    content: SceneContentRenderer,
    instrumentation: MutableSceneInstrumentation,
    reducedMotion = false,
  ) {
    this.#dom = dom;
    this.#content = content;
    this.#instrumentation = instrumentation;
    this.#reducedMotion = reducedMotion;
  }
  public applyDelta(
    changes: SceneStoreDelta["affected"],
    immediateSuppressedIds?: readonly string[],
  ): number | undefined {
    const suppression = this.takeMatchingSuppression(changes);
    if (
      suppression !== undefined &&
      this.#entries.size === 0 &&
      this.#pendingEntrances.size === 0
    ) {
      return suppression.token;
    }
    const immediateSuppression =
      immediateSuppressedIds === undefined || immediateSuppressedIds.length === 0
        ? undefined
        : new Set(immediateSuppressedIds);
    const membershipChanged = changes.some(
      ({ before, after }) => before === null || after === null,
    );
    for (const change of changes) {
      this.applyChange(
        change,
        suppression !== undefined ||
          immediateSuppression?.has(change.id) === true ||
          (membershipChanged && change.domains.length === 1 && change.domains[0] === "order"),
      );
    }
    return suppression?.token;
  }
  public suppress(ids: readonly string[]): number {
    const uniqueIds = new Set(ids);
    if (uniqueIds.size > FILE_SCHEMA_LIMITS.elements) {
      throw new RangeError("A motion handoff cannot exceed the document element limit.");
    }
    const token = ++this.#nextSuppressionToken;
    this.#pendingSuppression = { ids: uniqueIds, token };
    return token;
  }
  public cancelSuppression(token: number): void {
    if (this.#pendingSuppression?.token === token) this.#pendingSuppression = undefined;
  }
  public expireSuppression(): void {
    this.#pendingSuppression = undefined;
  }
  public bindMountedEntrances(ids: readonly string[], frameTime: number): void {
    if (this.#reducedMotion || this.#resourceConstrained) {
      for (const id of ids) this.#pendingEntrances.delete(id);
      return;
    }
    for (const id of ids) {
      if (!this.#pendingEntrances.delete(id)) continue;
      this.startEntrance([id], frameTime);
    }
  }
  public finishEntranceBatch(): void {
    this.#pendingEntrances.clear();
  }
  public duration(durationMs: number): number {
    return this.#reducedMotion ? 0 : durationMs;
  }
  public refreshInstrumentation(): void {
    this.refreshCacheSize();
  }
  public cacheMemoryUsage(): number {
    return this.#cacheBytes;
  }
  public setReducedMotion(reduced: boolean): void {
    if (reduced === this.#reducedMotion) return;
    this.#reducedMotion = reduced;
    if (reduced) {
      this.#pendingEntrances.clear();
      this.#pendingSuppression = undefined;
      this.finishAll(false);
    }
  }
  public setResourceConstrained(constrained: boolean): void {
    if (constrained === this.#resourceConstrained) return;
    this.#resourceConstrained = constrained;
    if (!constrained) return;
    this.#pendingEntrances.clear();
    for (const entry of [...this.#entries.values()]) {
      if (entry.kind === "entrance" || entry.kind === "exit" || entry.kind === "crossfade") {
        this.#instrumentation.motionEvictions +=
          entry.kind === "entrance" ? 0 : entry.visual.nodes.length;
        this.finishEntry(entry, false);
      }
    }
  }
  public applySelectionPath(
    path: string | null,
    handlePath: string | null,
    fill: "accent" | "none",
  ): void {
    this.#dom.selectionOverlayPath.setAttribute("data-selection-fill", fill);
    this.#selectionMotion = this.setOverlay(
      this.#dom.selectionOverlayPath,
      path,
      this.#selectionMotion,
    );
    this.#selectionHandleMotion = this.setOverlay(
      this.#dom.selectionHandlePath,
      handlePath,
      this.#selectionHandleMotion,
    );
  }
  public applySnapPath(path: string | null): void {
    this.#dom.snapMarkerPath.setAttribute("d", path ?? "");
    writeMotionStyle(this.#dom.snapMarkerPath, 1, 1);
  }
  public interruptForPointerDown(): void {
    this.#pendingSuppression = undefined;
    this.#pendingEntrances.clear();
    if (!this.hasPending()) return;
    this.#instrumentation.motionInterruptions += 1;
    this.finishAll(false);
  }
  public get pending(): boolean {
    return this.hasPending();
  }
  public write(frameTime: number, deadline: number, now: () => number, first = false): boolean {
    if (!this.hasPending()) return false;
    if (!first && now() >= deadline) return true;
    const effectiveTime =
      this.#lastFrameTime === undefined ? frameTime : Math.max(frameTime, this.#lastFrameTime + 16);
    this.#lastFrameTime = effectiveTime;
    this.#instrumentation.motionFrames += 1;
    this.writeEntries(effectiveTime, deadline, now, first);
    const pending = this.hasPending();
    if (!pending) this.#lastFrameTime = undefined;
    return pending;
  }
  public writeSelectionFeedback(frameTime: number): void {
    if (this.#selectionMotion === undefined && this.#selectionHandleMotion === undefined) return;
    const effectiveTime =
      this.#lastSelectionFrameTime === undefined
        ? frameTime
        : Math.max(frameTime, this.#lastSelectionFrameTime + 16);
    this.#lastSelectionFrameTime = effectiveTime;
    this.#selectionMotion = this.writeOverlay(
      this.#dom.selectionOverlayPath,
      this.#selectionMotion,
      effectiveTime,
    );
    this.#selectionHandleMotion = this.writeOverlay(
      this.#dom.selectionHandlePath,
      this.#selectionHandleMotion,
      effectiveTime,
    );
    if (this.#selectionMotion === undefined && this.#selectionHandleMotion === undefined)
      this.#lastSelectionFrameTime = undefined;
  }
  private writeEntries(
    frameTime: number,
    deadline: number,
    now: () => number,
    first: boolean,
  ): void {
    this.#frameCursor ??= this.#entries.values();
    const entries = this.#entries.size;
    for (let count = 0; count < entries; count += 1) {
      if ((count > 0 || !first) && now() >= deadline) return;
      let next = this.#frameCursor.next();
      if (next.done === true && count === 0 && this.#entries.size > 0) {
        this.#frameCursor = this.#entries.values();
        next = this.#frameCursor.next();
      }
      if (next.done === true) {
        this.#frameCursor = undefined;
        return;
      }
      this.writeEntry(next.value, frameTime);
    }
  }
  public release(): void {
    this.finishAll(true);
    this.#pendingSuppression = undefined;
    this.#pendingEntrances.clear();
    this.#entryByElementId.clear();
  }
  private startEntrance(ids: readonly string[], frameTime: number): void {
    const visible = ids.filter((id) => this.#content.hasMounted(id));
    if (visible.length === 0) return;
    this.#content.setElementMotion(visible, 0, 0.96);
    this.add({ id: ++this.#nextId, ids: visible, kind: "entrance", startTime: frameTime });
    this.#instrumentation.motionEntrances += visible.length;
  }
  private startExit(elements: readonly InkElementV1[]): void {
    const visible = elements.filter(({ id }) => this.#content.hasMounted(id));
    const ids = visible.map(({ id }) => id);
    const visual = this.createVisual(visible);
    this.#content.setElementMotion(ids, 0);
    if (visual.nodes.length === 0) return;
    this.add({ id: ++this.#nextId, ids, kind: "exit", startTime: undefined, visual });
    this.#instrumentation.motionTombstones += visual.nodes.length;
  }
  private startGeometry(from: readonly InkElementV1[], to: readonly InkElementV1[]): void {
    const visibleFrom: InkElementV1[] = [];
    const visibleTo: InkElementV1[] = [];
    for (let index = 0; index < to.length; index += 1) {
      const target = to[index];
      const source = from[index];
      if (target === undefined || source === undefined || !this.#content.hasMounted(target.id)) {
        continue;
      }
      this.#content.applyElementPreview(source);
      visibleFrom.push(source);
      visibleTo.push(target);
    }
    if (visibleTo.length === 0) return;
    this.add({
      current: visibleFrom,
      from: visibleFrom,
      id: ++this.#nextId,
      ids: visibleTo.map(({ id }) => id),
      kind: "geometry",
      startTime: undefined,
      to: visibleTo,
    });
    this.#instrumentation.motionGeometryTransitions += visibleTo.length;
  }
  private startCrossfade(elements: readonly InkElementV1[], ids: readonly string[]): void {
    const visible: InkElementV1[] = [];
    const visibleIds: string[] = [];
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      const id = ids[index];
      if (element === undefined || id === undefined || !this.#content.hasMounted(id)) continue;
      visible.push(element);
      visibleIds.push(id);
    }
    const visual = this.createVisual(visible);
    if (visual.nodes.length === 0) return;
    this.#content.setElementMotion(visibleIds, 0);
    this.add({
      id: ++this.#nextId,
      ids: visibleIds,
      kind: "crossfade",
      startTime: undefined,
      visual,
    });
    this.#instrumentation.motionCrossfades += visual.nodes.length;
  }
  private writeEntry(entry: MotionEntry, frameTime: number): void {
    entry.startTime ??= frameTime;
    const raw = Math.min(1, (frameTime - entry.startTime) / TRANSITION_DURATIONS.fallback);
    const progress = standardMotionProgress(raw);
    if (entry.kind === "entrance") {
      this.#content.setElementMotion(entry.ids, progress, 0.96 + progress * 0.04);
    } else if (entry.kind === "exit") {
      writeMotionVisual(entry.visual, 1 - progress, 1 - progress * 0.04);
    } else if (entry.kind === "geometry") this.writeGeometry(entry, progress);
    else {
      this.#content.setElementMotion(entry.ids, progress);
      writeMotionVisual(entry.visual, 1 - progress, 1);
    }
    if (raw >= 1) this.finishEntry(entry, false);
  }
  private writeGeometry(entry: GeometryMotionEntry, progress: number): void {
    const current: InkElementV1[] = [];
    for (let index = 0; index < entry.to.length; index += 1) {
      const from = entry.from[index];
      const to = entry.to[index];
      if (from !== undefined && to !== undefined) {
        const element = interpolateElement(from, to, progress);
        current.push(element);
        this.#content.applyElementPreview(element);
      }
    }
    entry.current = current;
  }
  private finishEntry(entry: MotionEntry, releasing: boolean): void {
    if (!this.#entries.delete(entry.id)) return;
    if (entry.kind === "exit" || entry.kind === "crossfade") {
      removeMotionVisual(entry.visual);
      this.#cacheEntries -= entry.visual.nodes.length;
      this.#cacheBytes -= entry.visual.bytes;
    }
    if (!releasing && entry.kind !== "exit") {
      this.#content.setElementMotion(entry.ids, null);
      if (entry.kind === "geometry") {
        for (const id of entry.ids) this.#content.clearElementPreview(id);
      }
    }
    for (const id of entry.ids) {
      if (this.#entryByElementId.get(id) === entry.id) this.#entryByElementId.delete(id);
    }
    this.refreshCacheSize();
  }

  private cancelId(id: string): InkElementV1 | undefined {
    const entryId = this.#entryByElementId.get(id);
    const entry = entryId === undefined ? undefined : this.#entries.get(entryId);
    if (entry === undefined) return undefined;
    const index = entry.ids.indexOf(id);
    const rendered = entry.kind === "geometry" ? entry.current[index] : undefined;
    this.finishEntry(entry, false);
    return rendered;
  }

  private createVisual(elements: readonly InkElementV1[]): MotionVisual {
    if (this.#cacheEntries >= MAX_MOTION_PATHS) this.evictOldestVisual();
    return createMotionVisual(
      this.#dom.ownerDocument,
      this.#dom.motionGroup,
      elements,
      MAX_MOTION_PATHS - this.#cacheEntries,
      MAX_MOTION_BYTES - this.#cacheBytes,
      (element) => this.#content.readCanonicalStrokePath(element),
    );
  }

  private evictOldestVisual(): void {
    for (const entry of this.#entries.values()) {
      if (entry.kind !== "exit" && entry.kind !== "crossfade") continue;
      this.#instrumentation.motionEvictions += entry.visual.nodes.length;
      this.finishEntry(entry, false);
      return;
    }
  }

  private setOverlay(
    node: SVGPathElement,
    path: string | null,
    current: OverlayMotion | undefined,
  ): OverlayMotion | undefined {
    const next = path ?? "";
    const previous = node.getAttribute("d") ?? "";
    // Selection geometry is essential feedback, even when optional scene work is deferred.
    if (next !== "") {
      if (next !== previous) node.setAttribute("d", next);
      writeMotionStyle(node, 1, 1);
      return undefined;
    }
    if (next === previous) return current;
    if (this.#reducedMotion) {
      this.clearOverlay(node);
      writeMotionStyle(node, 1, 1);
      return undefined;
    }
    if (current !== undefined) return current;
    writeMotionStyle(node, 1, 1);
    return { startTime: undefined };
  }

  private writeOverlay(
    node: SVGPathElement,
    motion: OverlayMotion | undefined,
    frameTime: number,
  ): OverlayMotion | undefined {
    if (motion === undefined) return undefined;
    motion.startTime ??= frameTime;
    const raw = Math.min(1, (frameTime - motion.startTime) / TRANSITION_DURATIONS.fallback);
    const progress = standardMotionProgress(raw);
    const visible = 1 - progress;
    writeMotionStyle(node, visible, 1);
    if (raw < 1) return motion;
    this.clearOverlay(node);
    writeMotionStyle(node, 1, 1);
    return undefined;
  }

  private finishAll(releasing: boolean): void {
    this.#lastSelectionFrameTime = undefined;
    this.#frameCursor = undefined;
    for (const entry of this.#entries.values()) this.finishEntry(entry, releasing);
    this.#entryByElementId.clear();
    this.finishOverlay(this.#dom.selectionOverlayPath, this.#selectionMotion);
    this.finishOverlay(this.#dom.selectionHandlePath, this.#selectionHandleMotion);
    this.#selectionMotion = undefined;
    this.#selectionHandleMotion = undefined;
    this.#lastFrameTime = undefined;
    this.refreshCacheSize();
  }

  private clearOverlay(node: SVGPathElement): void {
    node.setAttribute("d", "");
  }

  private finishOverlay(node: SVGPathElement, motion: OverlayMotion | undefined): void {
    if (motion !== undefined) this.clearOverlay(node);
    writeMotionStyle(node, 1, 1);
  }

  private hasPending(): boolean {
    return (
      this.#entries.size > 0 ||
      this.#selectionMotion !== undefined ||
      this.#selectionHandleMotion !== undefined
    );
  }

  private add(entry: MotionEntry): void {
    this.#entries.set(entry.id, entry);
    if (entry.kind === "exit" || entry.kind === "crossfade") {
      this.#cacheEntries += entry.visual.nodes.length;
      this.#cacheBytes += entry.visual.bytes;
      this.refreshCacheSize();
    }
    for (const id of entry.ids) this.#entryByElementId.set(id, entry.id);
  }

  private applyChange(change: SceneStoreDelta["affected"][number], suppressBatch: boolean): void {
    const before = change.before;
    const after = change.after;
    const rendered = this.cancelId(change.id);
    if (before !== null && before !== undefined && after === null) {
      this.#pendingEntrances.delete(change.id);
      this.#instrumentation.motionRemovalInvalidations += 1;
    }
    if (this.motionDisabled(suppressBatch)) return;
    if (before === null && after !== null && after !== undefined) {
      this.#pendingEntrances.add(after.id);
      return;
    }
    if (before !== null && before !== undefined && after === null) {
      this.startExit([before]);
      return;
    }
    if (before === null || before === undefined || after === null || after === undefined) return;
    if (change.domains.includes("geometry")) {
      this.startGeometry([rendered ?? before], [after]);
    } else if (change.domains.includes("paint") || change.domains.includes("order")) {
      this.startCrossfade([before], [after.id]);
    }
  }

  private motionDisabled(suppressBatch: boolean): boolean {
    return this.#reducedMotion || this.#resourceConstrained || suppressBatch;
  }

  private takeMatchingSuppression(
    changes: SceneStoreDelta["affected"],
  ): PendingSuppression | undefined {
    const pending = this.#pendingSuppression;
    if (pending === undefined) return undefined;
    for (const change of changes) {
      if (!pending.ids.has(change.id)) continue;
      this.#pendingSuppression = undefined;
      return pending;
    }
    return undefined;
  }

  private refreshCacheSize(): void {
    this.#instrumentation.motionCacheBytes = this.#cacheBytes;
    this.#instrumentation.motionCacheEntries = this.#cacheEntries;
  }
}
