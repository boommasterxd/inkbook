import type { RenderBand } from "../../domain/commands/render-bands";
import type { InkElementV1 } from "../../domain/schema/public";
import { MountSlice, mountCost, type MountYieldReason } from "./mount-slice";
import {
  appendElementToFragment,
  createMountedElement,
  firstPath,
  removeMountedElement,
  removeMountedElementNode,
  updatePreviewTransform,
  type MountedSceneElement,
} from "./mounted-element";
import type { SceneDom } from "./scene-dom";
import type { ScenePathCache } from "./path-cache";
import type { MutableSceneInstrumentation, SceneElementRecord, SceneStorePort } from "./types";
import type { BandVisibility, SceneVisibilityState, VisibilityResult } from "./visibility-state";

export interface PreviewTransform {
  readonly strokeWidthScale: number | null;
  readonly transform: string | null;
  readonly version: number;
}

interface ReconciliationCursor {
  band: RenderBand;
  index: number;
  run: PendingMutationRun | undefined;
  successor: MountedSceneElement | undefined;
}

interface PendingMutationRun {
  band: RenderBand;
  capacity: number;
  count: number;
  readonly entrants: boolean[];
  readonly entries: Array<MountedSceneElement | undefined>;
  successor: MountedSceneElement | undefined;
}

interface PendingReconciliation {
  readonly entrants: Map<string, MountedSceneElement>;
  readonly exitIds: string[];
  exitIndex: number;
  sliceExits: boolean;
  readonly exits: MapIterator<[string, MountedSceneElement]>;
  readonly runs: PendingMutationRun[];
  runCount: number;
  readonly visibility: VisibilityResult;
  readonly cursor: ReconciliationCursor;
}

interface ReconciliationResult {
  readonly committedVisibility?: VisibilityResult;
  readonly pending: boolean;
  readonly newlyMountedIds: readonly string[];
}

interface SceneVisibilityReconcilerOptions {
  readonly dom: SceneDom;
  readonly instrumentation: MutableSceneInstrumentation;
  readonly mounted: Map<string, MountedSceneElement>;
  readonly orderDirty: Record<RenderBand, Set<string>>;
  readonly pathCache: ScenePathCache;
  readonly store: SceneStorePort;
  readonly visibility: SceneVisibilityState;
}

const EXIT_SLICE_NODE_BUDGET = 64;

const EMPTY_IDS: readonly string[] = Object.freeze([]);

/** Stages entrants off-DOM and removes obsolete nodes in bounded frame slices. */
export class SceneVisibilityReconciler {
  #cancelled = false;
  #entrantCapacity = 0;
  readonly #entrants = new Map<string, MountedSceneElement>();
  #exitCapacity = 0;
  readonly #exitIds: string[] = [];
  #newlyMountedCapacity = 0;
  readonly #newlyMountedIds: string[] = [];
  #pending: PendingReconciliation | undefined;
  #promotedId: string | undefined;
  readonly #runs: PendingMutationRun[] = [];

  public constructor(private readonly options: SceneVisibilityReconcilerOptions) {}

  public get needsRestart(): boolean {
    return this.#cancelled;
  }

  public replace(visibility: VisibilityResult): void {
    this.cancel();
    this.#cancelled = false;
    this.#pending = {
      cursor: {
        band: "highlight",
        index: visibility.highlight.count - 1,
        run: undefined,
        successor: undefined,
      },
      entrants: this.#entrants,
      exitIds: this.#exitIds,
      exitIndex: 0,
      sliceExits: true,
      exits: this.options.mounted.entries(),
      runs: this.#runs,
      runCount: 0,
      visibility,
    };
  }

  public cancel(): void {
    const pending = this.#pending;
    this.#cancelled ||= pending !== undefined;
    const partialId = pending?.exitIds[pending.exitIndex];
    const partial = partialId === undefined ? undefined : this.options.mounted.get(partialId);
    if (partial !== undefined && partial.detachedPathCount > 0) {
      this.options.orderDirty[partial.band].add(partial.id);
    }
    const entrants = this.#pending?.entrants;
    if (entrants !== undefined) {
      for (const entry of entrants.values()) {
        this.options.pathCache.retain(entry.id, entry.geometryVersion, entry.pathParts);
      }
    }
    this.#pending = undefined;
    this.resetBuffers();
  }

  public promote(id: string): boolean {
    if (
      this.options.mounted.has(id) ||
      (this.#pending?.entrants.has(id) ?? false) ||
      !this.options.visibility.contains(id)
    ) {
      return false;
    }
    this.#promotedId = id;
    return true;
  }

  public reconcile(
    deadline: number,
    now: () => number,
    previewTransforms: ReadonlyMap<string, PreviewTransform>,
    previewElements: ReadonlyMap<string, InkElementV1>,
  ): ReconciliationResult {
    const pending = this.#pending;
    if (pending === undefined) return { newlyMountedIds: EMPTY_IDS, pending: false };
    const slice = new MountSlice(deadline, now);
    let reason = this.scanExits(pending, slice, previewTransforms, previewElements);
    if (reason === undefined) {
      this.stagePromoted(pending, slice, previewTransforms);
      reason = this.stageBands(pending, slice, previewTransforms);
    }
    this.recordSlice(slice, reason);
    if (reason !== undefined) return { newlyMountedIds: EMPTY_IDS, pending: true };
    if (!this.commitExits(pending, deadline, now)) {
      return { newlyMountedIds: EMPTY_IDS, pending: true };
    }
    const newlyMountedIds = this.commit(pending);
    this.#pending = undefined;
    return { committedVisibility: pending.visibility, newlyMountedIds, pending: false };
  }

  public release(): void {
    this.cancel();
    this.#promotedId = undefined;
  }

  private scanExits(
    pending: PendingReconciliation,
    slice: MountSlice,
    previews: ReadonlyMap<string, PreviewTransform>,
    previewElements: ReadonlyMap<string, InkElementV1>,
  ): MountYieldReason | undefined {
    while (true) {
      const reason = slice.blockingReason({ geometry: 1, strokePoints: 0 });
      if (reason !== undefined) return reason;
      const next = pending.exits.next();
      if (next.done) return undefined;
      const [id, entry] = next.value;
      slice.record({ geometry: 1, strokePoints: 0 });
      if (
        !this.options.visibility.contains(id) &&
        previews.get(id)?.transform == null &&
        !previewElements.has(id)
      ) {
        this.#exitCapacity = this.recordGrowth(this.#exitCapacity, pending.exitIds.length + 1);
        pending.exitIds.push(id);
        if (!entry.fadeActive && this.options.store.get(id) === undefined) {
          pending.sliceExits = false;
        }
      }
    }
  }

  private stagePromoted(
    pending: PendingReconciliation,
    slice: MountSlice,
    previews: ReadonlyMap<string, PreviewTransform>,
  ): void {
    const id = this.#promotedId;
    if (id === undefined) return;
    this.#promotedId = undefined;
    const record = this.options.store.get(id);
    if (record === undefined || !this.options.visibility.contains(id)) return;
    this.stageEntry(pending, record, previews);
    slice.record(mountCost(record));
  }

  private stageBands(
    pending: PendingReconciliation,
    slice: MountSlice,
    previews: ReadonlyMap<string, PreviewTransform>,
  ): MountYieldReason | undefined {
    while (true) {
      const visible = bandVisibility(pending.cursor, pending.visibility);
      while (pending.cursor.index >= 0) {
        const index = pending.cursor.index;
        pending.cursor.index -= 1;
        const id = visible.ids[index];
        const reason = this.stageVisibleId(id, pending, slice, previews);
        if (reason !== undefined) {
          pending.cursor.index += 1;
          return reason;
        }
      }
      this.finishRun(pending);
      if (pending.cursor.band === "content") return undefined;
      pending.cursor.band = "content";
      pending.cursor.index = pending.visibility.content.count - 1;
      pending.cursor.successor = undefined;
    }
  }

  private stageVisibleId(
    id: string | undefined,
    pending: PendingReconciliation,
    slice: MountSlice,
    previews: ReadonlyMap<string, PreviewTransform>,
  ): MountYieldReason | undefined {
    if (id === undefined) return undefined;
    const entrant = pending.entrants.get(id);
    if (entrant !== undefined) {
      this.addMutation(pending.cursor, entrant, true);
      return undefined;
    }
    const mounted = this.options.mounted.get(id);
    if (mounted !== undefined) {
      if (!this.options.orderDirty[pending.cursor.band].has(id)) {
        this.finishRun(pending);
        pending.cursor.successor = mounted;
        return undefined;
      }
      const cost = { geometry: 1, strokePoints: 0 };
      const reason = slice.blockingReason(cost);
      if (reason === undefined) {
        this.addMutation(pending.cursor, mounted, false);
        slice.record(cost);
      }
      return reason;
    }
    const record = this.options.store.get(id);
    if (record === undefined || record.band !== pending.cursor.band) return undefined;
    const cost = mountCost(record);
    const reason = slice.blockingReason(cost);
    if (reason !== undefined) return reason;
    this.addMutation(pending.cursor, this.stageEntry(pending, record, previews), true);
    slice.record(cost);
    return undefined;
  }

  private stageEntry(
    pending: PendingReconciliation,
    record: SceneElementRecord,
    previews: ReadonlyMap<string, PreviewTransform>,
  ): MountedSceneElement {
    const cached = this.options.pathCache.take(record.id, record.geometryVersion);
    const parts = cached ?? this.options.pathCache.build(record.element);
    const entry = createMountedElement(
      this.options.dom.ownerDocument,
      record,
      parts,
      this.options.instrumentation,
    );
    const preview = previews.get(record.id);
    if (preview !== undefined) {
      updatePreviewTransform(
        entry,
        preview.transform,
        preview.version,
        preview.strokeWidthScale,
        this.options.instrumentation,
      );
    }
    pending.entrants.set(record.id, entry);
    this.#entrantCapacity = this.recordGrowth(this.#entrantCapacity, pending.entrants.size);
    return entry;
  }

  private addMutation(
    cursor: ReconciliationCursor,
    entry: MountedSceneElement,
    entrant: boolean,
  ): void {
    cursor.run ??= this.prepareRun(cursor);
    const run = cursor.run;
    run.capacity = this.recordGrowth(run.capacity, run.count + 1);
    run.entries[run.count] = entry;
    run.entrants[run.count] = entrant;
    run.count += 1;
  }

  private finishRun(pending: PendingReconciliation): void {
    const run = pending.cursor.run;
    if (run === undefined) return;
    pending.runCount += 1;
    pending.cursor.run = undefined;
  }

  private commit(pending: PendingReconciliation): readonly string[] {
    for (const [id, entry] of pending.entrants) this.options.mounted.set(id, entry);
    this.#newlyMountedIds.length = 0;
    for (let index = 0; index < pending.runCount; index += 1) {
      const run = pending.runs[index];
      if (run !== undefined) this.flushRun(run);
    }
    this.options.orderDirty.content.clear();
    this.options.orderDirty.highlight.clear();
    return this.#newlyMountedIds;
  }

  private commitExits(
    pending: PendingReconciliation,
    deadline: number,
    now: () => number,
  ): boolean {
    let removedNodes = 0;
    while (pending.exitIndex < pending.exitIds.length) {
      if (
        pending.sliceExits &&
        (removedNodes >= EXIT_SLICE_NODE_BUDGET || (removedNodes > 0 && now() >= deadline))
      ) {
        return false;
      }
      const id = pending.exitIds[pending.exitIndex];
      const entry = id === undefined ? undefined : this.options.mounted.get(id);
      if (entry === undefined) {
        pending.exitIndex += 1;
        continue;
      }
      if (pending.sliceExits) {
        removedNodes += 1;
        if (!removeMountedElementNode(entry)) continue;
      } else removeMountedElement(entry);
      pending.exitIndex += 1;
      this.options.mounted.delete(entry.id);
      const record = this.options.store.get(entry.id);
      if (record === undefined) {
        this.options.pathCache.invalidate(entry.id);
        this.options.visibility.releaseId(entry.id);
      } else this.options.pathCache.retain(entry.id, entry.geometryVersion, entry.pathParts);
      this.options.instrumentation.domExits += 1;
    }
    return true;
  }

  private flushRun(run: PendingMutationRun): void {
    const fragment = createFragment(this.options.dom.ownerDocument);
    for (let index = run.count - 1; index >= 0; index -= 1) {
      const entry = run.entries[index];
      if (entry === undefined) continue;
      appendElementToFragment(entry, fragment);
      if (run.entrants[index]) {
        this.#newlyMountedCapacity = this.recordGrowth(
          this.#newlyMountedCapacity,
          this.#newlyMountedIds.length + 1,
        );
        this.#newlyMountedIds.push(entry.id);
        this.options.instrumentation.domEntrants += 1;
      } else {
        entry.rank = this.options.store.get(entry.id)?.rank ?? Number.MAX_SAFE_INTEGER;
        this.options.instrumentation.domReorders += 1;
      }
    }
    this.options.dom
      .group(run.band)
      .insertBefore(fragment, run.successor === undefined ? null : firstPath(run.successor));
    this.options.instrumentation.domFragmentRuns += 1;
  }

  private prepareRun(cursor: ReconciliationCursor): PendingMutationRun {
    const pending = this.#pending;
    if (pending === undefined)
      throw new Error("Cannot stage a visibility run without pending work.");
    let run = pending.runs[pending.runCount];
    if (run === undefined) {
      run = {
        band: cursor.band,
        capacity: 0,
        count: 0,
        entrants: [],
        entries: [],
        successor: cursor.successor,
      };
      pending.runs[pending.runCount] = run;
      this.options.instrumentation.collectionAllocations += 1;
    } else {
      run.band = cursor.band;
      run.count = 0;
      run.successor = cursor.successor;
    }
    return run;
  }

  private recordGrowth(current: number, required: number): number {
    if (required <= current) return current;
    let capacity = Math.max(16, current || 1);
    while (capacity < required) capacity *= 2;
    this.options.instrumentation.collectionAllocations += 1;
    return capacity;
  }

  private resetBuffers(): void {
    this.#entrants.clear();
    this.#exitIds.length = 0;
    this.#newlyMountedIds.length = 0;
    for (const run of this.#runs) {
      for (let index = 0; index < run.count; index += 1) run.entries[index] = undefined;
      run.count = 0;
      run.successor = undefined;
    }
  }

  private recordSlice(slice: MountSlice, reason: MountYieldReason | undefined): void {
    if (slice.elements === 0) return;
    this.options.instrumentation.mountSlices += 1;
    this.options.instrumentation.maximumMountSliceElements = Math.max(
      this.options.instrumentation.maximumMountSliceElements,
      slice.elements,
    );
    this.options.instrumentation.maximumMountSliceGeometryCost = Math.max(
      this.options.instrumentation.maximumMountSliceGeometryCost,
      slice.geometryCost,
    );
    this.options.instrumentation.maximumMountSliceStrokePoints = Math.max(
      this.options.instrumentation.maximumMountSliceStrokePoints,
      slice.strokePoints,
    );
    if (reason === "budget") this.options.instrumentation.mountBudgetYields += 1;
    else if (reason === "deadline") this.options.instrumentation.mountDeadlineYields += 1;
  }
}

function bandVisibility(
  cursor: ReconciliationCursor,
  visibility: VisibilityResult,
): BandVisibility {
  return cursor.band === "highlight" ? visibility.highlight : visibility.content;
}

function createFragment(ownerDocument: Document): DocumentFragment {
  const create = ownerDocument.createDocumentFragment.bind(ownerDocument);
  return create();
}
