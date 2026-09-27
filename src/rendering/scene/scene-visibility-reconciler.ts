import {
  publishVisibilityRun,
  removeVisibilityExits,
  RetainedDomOrder,
  type PendingMutationRun,
} from "./visibility-publication";
import { SceneMountPreparation, type PreviewTransform } from "./scene-mount-preparation";
import type { RenderBand } from "../../domain/commands/render-bands";
import type { InkElementV1 } from "../../domain/schema/public";
import { MountSlice, mountCost, type MountYieldReason } from "./mount-slice";
import { updatePreviewTransform, type MountedSceneElement } from "./mounted-element";
import type { SceneDom } from "./scene-dom";
import type { ScenePathCache } from "./path-cache";
import type { MutableSceneInstrumentation, SceneElementRecord, SceneStorePort } from "./types";
import type { BandVisibility, SceneVisibilityState, VisibilityResult } from "./visibility-state";

export type { PreviewTransform } from "./scene-mount-preparation";

interface ReconciliationCursor {
  band: RenderBand;
  index: number;
  run: PendingMutationRun | undefined;
  successor: MountedSceneElement | undefined;
}

interface PendingReconciliation {
  readonly entrants: Map<string, MountedSceneElement>;
  readonly exitIds: string[];
  exitIndex: number;
  published: boolean;
  readonly progressive: boolean;
  targetPublished: boolean;
  retainedOrderPreserved: boolean;
  readonly exits: MapIterator<[string, MountedSceneElement]>;
  readonly runs: PendingMutationRun[];
  runCount: number;
  readonly order: RetainedDomOrder;
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
  readonly isExitReady?: (id: string, now: number) => boolean;
  readonly orderDirty: Record<RenderBand, Set<string>>;
  readonly pathCache: ScenePathCache;
  readonly store: SceneStorePort;
  readonly visibility: SceneVisibilityState;
}

const EMPTY_IDS: readonly string[] = Object.freeze([]);

/** Publishes ordered viewport batches and removes obsolete nodes in bounded frame slices. */
export class SceneVisibilityReconciler {
  #cancelled = false;
  #orderEpoch = 0;
  #entrantCapacity = 0;
  readonly #entrants = new Map<string, MountedSceneElement>();
  #exitCapacity = 0;
  readonly #exitIds: string[] = [];
  readonly #newlyMountedIds: string[] = [];
  #pending: PendingReconciliation | undefined;
  #promotedId: string | undefined;
  readonly #runs: PendingMutationRun[] = [];
  readonly #publishedEntrantIds: string[] = [];

  readonly #preparation: SceneMountPreparation;

  public constructor(private readonly options: SceneVisibilityReconcilerOptions) {
    this.#preparation = new SceneMountPreparation({
      ...options,
      ownerDocument: options.dom.ownerDocument,
    });
  }

  public memoryUsage(): number {
    const orderBytes = this.#pending?.order.memoryUsage() ?? 0;
    return this.#preparation.memoryUsage() + this.#publishedEntrantIds.length * 8 + orderBytes;
  }

  public get needsRestart(): boolean {
    return this.#cancelled;
  }

  public get hasPendingCleanup(): boolean {
    return this.#pending?.published === true;
  }

  // Retargeting preserves the scan; exit eligibility is checked against the final target.
  public replace(visibility: VisibilityResult, progressive = false): void {
    const exits =
      this.#pending?.published === false ? this.#pending.exits : this.options.mounted.entries();
    this.#exitIds.push(...this.#publishedEntrantIds);
    this.#publishedEntrantIds.length = 0;
    this.cancel(true);
    this.#promotedId ??= this.#preparation.pendingId;
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
      published: false,
      progressive,
      targetPublished: false,
      retainedOrderPreserved: true,
      exits,
      runs: this.#runs,
      runCount: 0,
      order: new RetainedDomOrder(this.options.dom, this.#orderEpoch),
      visibility,
    };
  }

  public cancel(preservePending = false): void {
    const pending = this.#pending;
    preservePending &&= pending?.published === false;
    this.#preparation.cancel(
      preservePending ? (id) => this.options.visibility.contains(id) : undefined,
    );
    this.#cancelled ||= pending !== undefined;
    const partialId = pending?.exitIds[pending.exitIndex];
    const partial = partialId === undefined ? undefined : this.options.mounted.get(partialId);
    if (partial !== undefined && partial.detachedPathCount > 0) {
      this.options.orderDirty[partial.band].add(partial.id);
    }
    const entrants = pending?.published === true ? undefined : pending?.entrants;
    if (entrants !== undefined) {
      for (const entry of entrants.values()) {
        if (
          preservePending &&
          this.options.visibility.contains(entry.id) &&
          this.#preparation.isCurrent(entry)
        )
          continue;
        this.options.pathCache.retain(entry.id, entry.geometryVersion, entry.pathParts);
        entrants.delete(entry.id);
      }
    }
    pending?.order.release();
    this.#pending = undefined;
    this.resetBuffers(preservePending);
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
    const isExit = (id: string) =>
      !this.options.visibility.contains(id) &&
      previewTransforms.get(id)?.transform == null &&
      !previewElements.has(id);
    if (pending.published) {
      if (removeVisibilityExits(pending, this.options, { deadline, now, isExit }))
        this.#pending = undefined;
      return { newlyMountedIds: EMPTY_IDS, pending: false };
    }
    const slice = new MountSlice(deadline, now, pending.progressive ? 64 : Infinity);
    let reason = this.scanExits(pending, slice);
    if (reason === undefined) {
      reason = this.stagePromoted(pending, slice, previewTransforms);
      reason ??= this.stageBands(pending, slice, previewTransforms);
    }
    slice.report(this.options.instrumentation, reason);
    if (reason !== undefined) {
      const newlyMountedIds = pending.progressive ? this.publishProgress(pending) : EMPTY_IDS;
      const committedVisibility = pending.targetPublished ? undefined : pending.visibility;
      pending.targetPublished ||= newlyMountedIds.length > 0;
      return {
        ...(newlyMountedIds.length === 0 || committedVisibility === undefined
          ? {}
          : { committedVisibility }),
        newlyMountedIds,
        pending: true,
      };
    }
    const newlyMountedIds = this.commit(pending);
    pending.published = true;
    this.#publishedEntrantIds.length = 0;
    if (removeVisibilityExits(pending, this.options, { deadline, now, isExit }))
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
  ): MountYieldReason | undefined {
    while (true) {
      const reason = slice.blockingReason({ geometry: 1, strokePoints: 0 });
      if (reason !== undefined) return reason;
      const next = pending.exits.next();
      if (next.done) return undefined;
      const [id] = next.value;
      slice.record({ geometry: 1, strokePoints: 0 });
      this.#exitCapacity = this.recordGrowth(this.#exitCapacity, pending.exitIds.length + 1);
      pending.exitIds.push(id);
    }
  }

  private stagePromoted(
    pending: PendingReconciliation,
    slice: MountSlice,
    previews: ReadonlyMap<string, PreviewTransform>,
  ): MountYieldReason | undefined {
    const id = this.#promotedId;
    if (id === undefined) return;
    this.#promotedId = undefined;
    const record = this.options.store.get(id);
    if (record === undefined || !this.options.visibility.contains(id)) return;
    const entry = this.stageEntry(pending, record, slice, previews);
    if (entry === undefined) this.#promotedId = id;
    slice.record(mountCost(record));
    if (entry === undefined) return "budget";
    if (!pending.progressive) return undefined;
    const run = this.prepareRun({
      band: entry.band,
      index: 0,
      run: undefined,
      successor: this.promotedSuccessor(pending.visibility[entry.band], id),
    });
    run.entries[0] = entry;
    run.entrants[0] = true;
    run.count = 1;
    pending.runCount += 1;
    return "budget";
  }

  private promotedSuccessor(visible: BandVisibility, id: string): MountedSceneElement | undefined {
    let found = false;
    for (let index = 0; index < visible.count; index += 1) {
      const candidate = visible.ids[index]!;
      if (found) {
        const mounted = this.options.mounted.get(candidate);
        if (mounted !== undefined) return mounted;
      } else found = candidate === id;
    }
    return undefined;
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
      const preview = previews.get(id);
      updatePreviewTransform(
        entrant,
        preview?.transform ?? null,
        preview?.version ?? 0,
        preview?.strokeWidthScale ?? null,
        this.options.instrumentation,
      );
      if (!slice.claimPublicationNodes(publicationNodeCount(entrant))) return "budget";
      this.addMutation(pending.cursor, entrant, true);
      return undefined;
    }
    const mounted = this.options.mounted.get(id);
    if (mounted !== undefined) {
      if (
        mounted.committedOrderEpoch === this.#orderEpoch &&
        !this.options.orderDirty[pending.cursor.band].has(id)
      ) {
        this.observeRetainedOrder(pending, mounted);
        this.finishRun(pending);
        pending.cursor.successor = mounted;
        return undefined;
      }
      const cost = { geometry: 1, strokePoints: 0 };
      const reason = slice.blockingReason(cost);
      if (reason === undefined) {
        this.observeRetainedOrder(pending, mounted);
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
    const entry = this.stageEntry(pending, record, slice, previews);
    if (entry === undefined) return "budget";
    if (!slice.claimPublicationNodes(publicationNodeCount(entry))) return "budget";
    this.addMutation(pending.cursor, entry, true);
    slice.record(cost);
    return undefined;
  }

  private observeRetainedOrder(pending: PendingReconciliation, entry: MountedSceneElement): void {
    pending.retainedOrderPreserved &&= pending.order.observe(entry, pending.cursor.band);
  }

  private stageEntry(
    pending: PendingReconciliation,
    record: SceneElementRecord,
    slice: MountSlice,
    previews: ReadonlyMap<string, PreviewTransform>,
  ): MountedSceneElement | undefined {
    const entry = this.#preparation.stage(record, slice, previews.get(record.id));
    if (entry === undefined) return undefined;
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
    this.#newlyMountedIds.length = 0;
    const preserveRetainedOrder = pending.retainedOrderPreserved;
    for (let index = 0; index < pending.runCount; index += 1) {
      const run = pending.runs[index];
      if (run !== undefined)
        this.#newlyMountedIds.push(
          ...publishVisibilityRun(run, this.options, this.#orderEpoch, preserveRetainedOrder),
        );
    }
    this.#orderEpoch += 1;
    for (const band of [pending.visibility.highlight, pending.visibility.content]) {
      for (let index = 0; index < band.count; index += 1) {
        const entry = this.options.mounted.get(band.ids[index]!);
        if (entry !== undefined) entry.committedOrderEpoch = this.#orderEpoch;
      }
    }
    this.options.orderDirty.content.clear();
    this.options.orderDirty.highlight.clear();
    pending.order.release();
    return this.#newlyMountedIds;
  }

  private publishProgress(pending: PendingReconciliation): readonly string[] {
    const partial = pending.cursor.run;
    const successor = partial?.entries[partial.count - 1] ?? pending.cursor.successor;
    this.finishRun(pending);
    this.#newlyMountedIds.length = 0;
    for (let index = 0; index < pending.runCount; index += 1) {
      const run = pending.runs[index];
      if (run === undefined) continue;
      this.#newlyMountedIds.push(
        ...publishVisibilityRun(
          run,
          this.options,
          this.#orderEpoch,
          pending.retainedOrderPreserved,
        ),
      );
      for (let item = 0; item < run.count; item += 1) {
        const entry = run.entries[item];
        if (entry !== undefined) pending.entrants.delete(entry.id);
        run.entries[item] = undefined;
      }
      run.count = 0;
      run.successor = undefined;
    }
    this.#publishedEntrantIds.push(...this.#newlyMountedIds);
    pending.order.invalidate();
    pending.runCount = 0;
    pending.cursor.successor = successor;
    return this.#newlyMountedIds;
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

  private resetBuffers(preservePending: boolean): void {
    if (!preservePending) this.#entrants.clear();
    if (!preservePending) this.#exitIds.length = 0;
    if (!preservePending) this.#publishedEntrantIds.length = 0;
    this.#newlyMountedIds.length = 0;
    for (const run of this.#runs) {
      for (let index = 0; index < run.count; index += 1) run.entries[index] = undefined;
      run.count = 0;
      run.successor = undefined;
    }
  }
}

function bandVisibility(
  cursor: ReconciliationCursor,
  visibility: VisibilityResult,
): BandVisibility {
  return cursor.band === "highlight" ? visibility.highlight : visibility.content;
}

function publicationNodeCount(entry: MountedSceneElement): number {
  return entry.group === null ? entry.paths.length : 1;
}
