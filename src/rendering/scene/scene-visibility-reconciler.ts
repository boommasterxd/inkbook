import {
  publishVisibilityRuns,
  mountedRootCount,
  RetainedDomOrder,
  type PendingMutationRun,
} from "./visibility-publication";
import { SceneMountPreparation, type PreviewTransform } from "./scene-mount-preparation";
import { upcomingScenePathIds } from "./upcoming-scene-paths";
import type { InkElementV1 } from "../../domain/schema/public";
import { MountSlice } from "./mount-slice";
import type { MountYieldReason, ScenePublicationBudget } from "./mount-slice";
import { updatePreviewTransform, type MountedSceneElement } from "./mounted-element";
import type { SceneElementRecord } from "./types";
import type { VisibilityDelta, VisibilityResult } from "./visibility-state";
import type { SceneVisibilityPriority } from "./scene-entrant-priority";
import { stagePromotedVisibility } from "./promoted-visibility-entry";
import { completeDeltaPublication, orderDeltaPublication } from "./visibility-delta-reconciliation";
import {
  removeOrderedVisibilityExits,
  collectPendingVisibilityExits,
  hasPendingVisibilityCleanup,
  commitVisibilityReconciliation,
  completedVisibilityReconciliation,
  publishPendingVisibility,
  prepareVisibilityCleanup,
} from "./visibility-reconciliation-commit";
import { DeferredVisibilityExits } from "./deferred-visibility-exits";
import {
  canRetargetVisibilityDelta,
  createProgressiveVisibilityDelta,
  stageVisibilityBands,
  stageVisibilitySlice,
} from "./visibility-staging";
import {
  prepareReconciliationRun,
  recordReconciliationGrowth,
  resetReconciliationBuffers,
  reconciliationMemoryUsage,
  finishReconciliationRun,
} from "./reconciliation-buffers";
import type {
  PendingReconciliation,
  ReconciliationCursor,
  ReconciliationResult,
  SceneVisibilityReconcilerOptions,
} from "./reconciliation-state";

export type { PreviewTransform } from "./scene-mount-preparation";

const EMPTY_IDS: readonly string[] = Object.freeze([]);

/** Publishes ordered viewport batches and removes obsolete nodes in bounded frame slices. */
export class SceneVisibilityReconciler {
  #cancelled = false;
  #orderEpoch = 0;
  #entrantCapacity = 0;
  readonly #entrants = new Map<string, MountedSceneElement>();
  readonly #deferredExits = new DeferredVisibilityExits();
  #exitCapacity = 0;
  readonly #exitIds: string[] = [];
  readonly #newlyMountedIds: string[] = [];
  #pending: PendingReconciliation | undefined;
  #promotedId: string | undefined;
  readonly #runs: PendingMutationRun[] = [];
  readonly #publishedEntrantIds: string[] = [];
  readonly #preparation: SceneMountPreparation;
  #priority: SceneVisibilityPriority | undefined;
  #waitingForPaths = false;
  public constructor(private readonly options: SceneVisibilityReconcilerOptions) {
    this.#preparation = new SceneMountPreparation({
      ...options,
      ownerDocument: options.dom.ownerDocument,
      upcomingIds: () => upcomingScenePathIds(this.#pending, this.options.mounted),
    });
  }
  public memoryUsage(): number {
    return (
      this.#preparation.memoryUsage() +
      reconciliationMemoryUsage(
        this.#pending,
        this.#publishedEntrantIds.length,
        this.#deferredExits.size,
      )
    );
  }

  public get needsRestart(): boolean {
    return this.#cancelled;
  }

  public get hasPendingCleanup(): boolean {
    const pending = this.#pending;
    return pending !== undefined && hasPendingVisibilityCleanup(pending);
  }

  public get hasPendingWork(): boolean {
    return this.#pending !== undefined;
  }

  public get waitingForPaths(): boolean {
    return this.#waitingForPaths;
  }

  public setPriority(priority: SceneVisibilityPriority): void {
    this.#priority = priority;
  }

  public hasUnprotectedDeferredExit(
    previewTransforms: ReadonlyMap<string, PreviewTransform>,
    previewElements: () => ReadonlyMap<string, InkElementV1>,
  ): boolean {
    return (
      this.#deferredExits.size > 0 &&
      this.#deferredExits.hasUnprotected(previewTransforms, previewElements())
    );
  }

  // Retargeting preserves the scan; exit eligibility is checked against the final target.
  public replace(visibility: VisibilityResult, progressive = false, delta?: VisibilityDelta): void {
    const previousDelta = this.#pending?.delta;
    let useDelta = canRetargetVisibilityDelta(
      this.#pending,
      progressive,
      this.#cancelled,
      this.options,
      delta,
    );
    const exits =
      this.#pending?.published === false ? this.#pending.exits : this.options.mounted.entries();
    for (const id of this.#publishedEntrantIds) this.#exitIds.push(id);
    this.#publishedEntrantIds.length = 0;
    this.cancel(true);
    useDelta &&=
      this.options.orderDirty.content.size === 0 && this.options.orderDirty.highlight.size === 0;
    this.#deferredExits.drainInto(this.#exitIds);
    this.#promotedId ??= this.#preparation.pendingId;
    this.#cancelled = false;
    this.#waitingForPaths = false;
    if (useDelta && delta !== undefined) for (const id of delta.exited) this.#exitIds.push(id);
    const nextDelta = progressive
      ? createProgressiveVisibilityDelta(
          visibility,
          useDelta ? delta : undefined,
          this.options,
          this.#priority,
          this.#orderEpoch,
          useDelta ? previousDelta : undefined,
        )
      : undefined;
    this.#pending = {
      ...(nextDelta === undefined ? {} : { delta: nextDelta }),
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
      scanExits: !useDelta,
      exitScanComplete: useDelta,
      exitOrderPrepared: false,
      cleanupFirst: false,
      runs: this.#runs,
      runCount: 0,
      order: new RetainedDomOrder(this.options.dom, this.#orderEpoch),
      visibility,
    };
  }

  public cancel(preservePending = false): void {
    this.#waitingForPaths = false;
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
        this.options.detachedCache?.retain(entry);
        entrants.delete(entry.id);
      }
    }
    pending?.order.release();
    this.#pending = undefined;
    resetReconciliationBuffers({
      preservePending,
      exitCursor: pending,
      entrants: this.#entrants,
      exitIds: this.#exitIds,
      publishedEntrantIds: this.#publishedEntrantIds,
      newlyMountedIds: this.#newlyMountedIds,
      runs: this.#runs,
    });
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
    publication: ScenePublicationBudget,
  ): ReconciliationResult {
    const pending = this.#pending;
    if (pending === undefined) return { newlyMountedIds: EMPTY_IDS, pending: false };
    const isExit = (id: string) =>
      !this.options.visibility.contains(id) &&
      previewTransforms.get(id)?.transform == null &&
      !previewElements.has(id);
    const removeExits = () =>
      removeOrderedVisibilityExits(pending, this.options, {
        deadline,
        now,
        isExit,
        onSkipped: (id) =>
          this.#deferredExits.skipped(
            id,
            this.options.visibility.contains(id),
            this.options.mounted.has(id),
          ),
        onRemoved: (id) => this.#deferredExits.removed(id),
      });
    if (pending.published) {
      if (removeExits()) this.#pending = undefined;
      return { newlyMountedIds: EMPTY_IDS, pending: false };
    }
    const slice = new MountSlice(
      deadline,
      now,
      pending.progressive ? publication.remainingRoots : Infinity,
    );
    const reason =
      prepareVisibilityCleanup(pending, slice, {
        collect: () =>
          collectPendingVisibilityExits(pending, slice, this.options.instrumentation, (id) =>
            this.addExit(pending, id),
          ),
        remove: removeExits,
      }) ?? this.stageSlice(pending, slice, previewTransforms, deadline, now);
    this.#waitingForPaths = reason === "paths";
    slice.report(this.options.instrumentation, reason);
    if (pending.progressive)
      publication.remainingRoots = Math.max(0, publication.remainingRoots - slice.publicationNodes);
    if (reason !== undefined) {
      const newlyMountedIds = pending.progressive ? this.publishProgress(pending) : EMPTY_IDS;
      return publishPendingVisibility(pending, newlyMountedIds, {
        collect: () => {
          collectPendingVisibilityExits(pending, slice, this.options.instrumentation, (id) =>
            this.addExit(pending, id),
          );
        },
        remove: removeExits,
        canWork: () => now() < deadline,
        waitingForPaths: reason === "paths",
      });
    }
    // Prepared publication is one atomic DOM operation after its bounded preparation.
    this.#orderEpoch = commitVisibilityReconciliation(
      pending,
      this.options,
      this.#orderEpoch,
      this.#newlyMountedIds,
    );
    const newlyMountedIds = this.#newlyMountedIds;
    pending.published = true;
    this.#publishedEntrantIds.length = 0;
    if (pending.exitIds.length === 0 || (now() < deadline && removeExits()))
      this.#pending = undefined;
    return completedVisibilityReconciliation(pending, this.#orderEpoch, newlyMountedIds);
  }

  public release(): void {
    this.cancel();
    this.#promotedId = undefined;
    this.#deferredExits.clear();
  }

  private stageSlice(
    pending: PendingReconciliation,
    slice: MountSlice,
    previewTransforms: ReadonlyMap<string, PreviewTransform>,
    deadline: number,
    now: () => number,
  ): MountYieldReason | undefined {
    return stageVisibilitySlice(pending, slice, previewTransforms, {
      ...this.options,
      pendingId: () => this.#preparation.pendingId,
      waiting: () => this.#preparation.waiting,
      promoted: () => this.stagePromoted(pending, slice, previewTransforms),
      bands: () => this.stageBands(pending, slice, previewTransforms, deadline, now),
      stage: (record, allowLocal) =>
        this.stageEntry(pending, record, slice, previewTransforms, allowLocal),
      run: (band, successor) => this.prepareRun({ band, successor }),
      exit: (id) => this.addExit(pending, id),
    });
  }

  private addExit(pending: PendingReconciliation, id: string): void {
    this.#exitCapacity = recordReconciliationGrowth(
      this.#exitCapacity,
      pending.exitIds.length + 1,
      this.options.instrumentation,
    );
    pending.exitIds.push(id);
  }

  private stagePromoted(
    pending: PendingReconciliation,
    slice: MountSlice,
    previews: ReadonlyMap<string, PreviewTransform>,
  ): MountYieldReason | undefined {
    const result = stagePromotedVisibility(this.#promotedId, pending, slice, {
      ...this.options,
      waiting: () => this.#preparation.waiting,
      stage: (record) => this.stageEntry(pending, record, slice, previews),
      run: (entry, successor) => this.prepareRun({ band: entry.band, successor }),
    });
    this.#promotedId = result.id;
    return result.reason;
  }

  private stageBands(
    pending: PendingReconciliation,
    slice: MountSlice,
    previews: ReadonlyMap<string, PreviewTransform>,
    deadline: number,
    now: () => number,
  ): MountYieldReason | undefined {
    return stageVisibilityBands(pending, deadline, now, {
      finish: () => finishReconciliationRun(pending),
      entry: (id) => this.stageVisibleId(id, pending, slice, previews),
    });
  }

  private stageVisibleId(
    id: string | undefined,
    pending: PendingReconciliation,
    slice: MountSlice,
    previews: ReadonlyMap<string, PreviewTransform>,
  ): MountYieldReason | undefined {
    if (id === undefined) return undefined;
    this.options.instrumentation.visibilityReconcileVisits += 1;
    const entrant = pending.entrants.get(id);
    if (entrant !== undefined) return this.stagePreparedEntrant(entrant, pending, slice, previews);
    const mounted = this.options.mounted.get(id);
    if (mounted !== undefined) {
      if (
        mounted.committedOrderEpoch === this.#orderEpoch &&
        !this.options.orderDirty[pending.cursor.band].has(id) &&
        pending.retainedOrderPreserved
      ) {
        this.observeRetainedOrder(pending, mounted);
        if (pending.retainedOrderPreserved) {
          finishReconciliationRun(pending);
          pending.cursor.successor = mounted;
          return undefined;
        }
      }
      const reason = slice.blockingReason();
      if (reason === undefined) {
        this.observeRetainedOrder(pending, mounted);
        if (
          pending.progressive &&
          !pending.retainedOrderPreserved &&
          !slice.claimPublicationNodes(mountedRootCount(mounted))
        )
          return "budget";
        this.addMutation(pending.cursor, mounted, false);
        slice.record();
      }
      return reason;
    }
    const record = this.options.store.get(id);
    if (record === undefined || record.band !== pending.cursor.band) return undefined;
    const reason = slice.blockingReason();
    if (reason !== undefined) return reason;
    if (pending.progressive && !slice.canPublish) return "budget";
    const entry = this.stageEntry(pending, record, slice, previews);
    if (entry === undefined) return "budget";
    if (!slice.claimPublicationNodes(mountedRootCount(entry))) return "budget";
    this.addMutation(pending.cursor, entry, true);
    slice.record();
    return undefined;
  }
  private stagePreparedEntrant(
    entrant: MountedSceneElement,
    pending: PendingReconciliation,
    slice: MountSlice,
    previews: ReadonlyMap<string, PreviewTransform>,
  ): MountYieldReason | undefined {
    const preview = previews.get(entrant.id);
    updatePreviewTransform(
      entrant,
      preview?.transform ?? null,
      preview?.version ?? 0,
      preview?.strokeWidthScale ?? null,
      this.options.instrumentation,
    );
    if (!slice.claimPublicationNodes(mountedRootCount(entrant))) return "budget";
    this.addMutation(pending.cursor, entrant, true);
    return undefined;
  }

  private observeRetainedOrder(pending: PendingReconciliation, entry: MountedSceneElement): void {
    if (!pending.retainedOrderPreserved || pending.order.observe(entry, pending.cursor.band))
      return;
    if (pending.progressive) finishReconciliationRun(pending);
    pending.retainedOrderPreserved = false;
  }

  private stageEntry(
    pending: PendingReconciliation,
    record: SceneElementRecord,
    slice: MountSlice,
    previews: ReadonlyMap<string, PreviewTransform>,
    allowLocal = true,
  ): MountedSceneElement | undefined {
    const entry = this.#preparation.stage(record, slice, previews.get(record.id), allowLocal);
    if (entry === undefined) return undefined;
    pending.entrants.set(record.id, entry);
    this.#entrantCapacity = recordReconciliationGrowth(
      this.#entrantCapacity,
      pending.entrants.size,
      this.options.instrumentation,
    );
    return entry;
  }

  private addMutation(
    cursor: ReconciliationCursor,
    entry: MountedSceneElement,
    entrant: boolean,
  ): void {
    cursor.run ??= this.prepareRun(cursor);
    const run = cursor.run;
    run.capacity = recordReconciliationGrowth(
      run.capacity,
      run.count + 1,
      this.options.instrumentation,
    );
    run.entries[run.count] = entry;
    run.entrants[run.count] = entrant;
    run.count += 1;
  }
  private publishProgress(pending: PendingReconciliation): readonly string[] {
    const partial = pending.cursor.run;
    const successor = partial?.entries[partial.count - 1] ?? pending.cursor.successor;
    finishReconciliationRun(pending);
    orderDeltaPublication(pending);
    publishVisibilityRuns({
      runs: pending.runs,
      count: pending.runCount,
      options: this.options,
      epoch: this.#orderEpoch,
      output: this.#newlyMountedIds,
      entrants: pending.entrants,
    });
    this.#publishedEntrantIds.push(...this.#newlyMountedIds);
    completeDeltaPublication(pending, this.#newlyMountedIds, this.options);
    pending.order.invalidate();
    pending.runCount = 0;
    pending.cursor.successor = successor;
    return this.#newlyMountedIds;
  }
  private prepareRun(cursor: Pick<ReconciliationCursor, "band" | "successor">): PendingMutationRun {
    return prepareReconciliationRun(this.#pending, cursor, this.options.instrumentation);
  }
}
