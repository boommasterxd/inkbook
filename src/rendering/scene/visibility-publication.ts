import type { RenderBand } from "../../domain/commands/render-bands";
import {
  appendElementToFragment,
  createFragment,
  firstPath,
  removeMountedElementNode,
  type MountedSceneElement,
} from "./mounted-element";
import type { SceneDom } from "./scene-dom";
import type { MutableSceneInstrumentation, SceneStorePort } from "./types";
import type { MountSlice, MountYieldReason, ScenePublicationBudget } from "./mount-slice";
import type { DetachedSceneElementCache } from "./detached-element-cache";

export interface PendingMutationRun {
  band: RenderBand;
  capacity: number;
  count: number;
  readonly entrants: boolean[];
  readonly entries: Array<MountedSceneElement | undefined>;
  preserveRetainedOrder: boolean;
  successor: MountedSceneElement | undefined;
}

interface PublicationOptions {
  readonly detachedCache?: DetachedSceneElementCache | undefined;
  readonly dom: SceneDom;
  readonly instrumentation: MutableSceneInstrumentation;
  readonly mounted: Map<string, MountedSceneElement>;
  readonly store: SceneStorePort;
}

function commitMountedEntry(
  entry: MountedSceneElement,
  run: PendingMutationRun,
  options: PublicationOptions,
  epoch: number,
): void {
  entry.rank = options.store.get(entry.id)?.rank ?? Number.MAX_SAFE_INTEGER;
  entry.committedRank = entry.rank;
  entry.committedOrderEpoch = epoch;
  entry.band = run.band;
  options.detachedCache?.registerMounted(entry, options.store);
}

function commitPublishedEntry(
  entry: MountedSceneElement,
  run: PendingMutationRun,
  options: PublicationOptions,
  epoch: number,
): boolean {
  commitMountedEntry(entry, run, options, epoch);
  const roots = publicationRootCount(entry);
  const connected = roots === 0;
  options.detachedCache?.commitReservation(entry);
  options.mounted.set(entry.id, entry);
  if (!connected) options.instrumentation.domEntrants += 1;
  options.instrumentation.domRootsPublished += roots;
  return connected;
}

/** A stable delta run has one exact physical successor, including cached offscreen anchors. */
export function publishStableEntrantRun(
  run: PendingMutationRun,
  options: PublicationOptions,
  epoch: number,
): string[] {
  const ids: string[] = [];
  let fragment: DocumentFragment | undefined;
  for (let index = run.count - 1; index >= 0; index -= 1) {
    const entry = run.entries[index];
    if (entry === undefined) continue;
    const connected = commitPublishedEntry(entry, run, options, epoch);
    ids.push(entry.id);
    if (connected) continue;
    fragment ??= createFragment(options.dom.ownerDocument);
    appendElementToFragment(entry, fragment);
  }
  if (fragment === undefined) return ids;
  options.dom
    .group(run.band)
    .insertBefore(fragment, run.successor === undefined ? null : firstPath(run.successor));
  options.instrumentation.domFragmentRuns += 1;
  return ids;
}

export function mountedRootCount(entry: MountedSceneElement): number {
  return entry.group === null ? entry.paths.length : 1;
}

/** Connected revisits have already paid their browser publication cost. */
export function publicationRootCount(entry: MountedSceneElement): number {
  return firstPath(entry).parentNode === null ? mountedRootCount(entry) : 0;
}

export function canPublishCachedElement(
  slice: MountSlice,
  cache: DetachedSceneElementCache | undefined,
  id: string,
): boolean {
  return slice.canPublish || cache?.isConnected(id) === true;
}

export function scanVisibilityExits(
  exits: Iterator<[string, MountedSceneElement]>,
  slice: MountSlice,
  instrumentation: MutableSceneInstrumentation,
  add: (id: string) => void,
): MountYieldReason | undefined {
  while (true) {
    const reason = slice.blockingReason();
    if (reason !== undefined) return reason;
    const next = exits.next();
    if (next.done) return undefined;
    instrumentation.visibilityReconcileVisits += 1;
    add(next.value[0]);
    slice.record();
  }
}

/** Checks stale retained entries against one physical sibling snapshot per band. */
export class RetainedDomOrder {
  readonly #previous: Partial<Record<RenderBand, MountedSceneElement>> = {};
  readonly #positions: Partial<Record<RenderBand, Map<Node, number>>> = {};

  public constructor(
    private readonly dom: SceneDom,
    private readonly epoch: number,
  ) {}

  public observe(entry: MountedSceneElement, band: RenderBand): boolean {
    const previous = this.#previous[band];
    this.#previous[band] = entry;
    if (entry.band !== band || entry.detachedPathCount > 0) return false;
    if (
      entry.committedOrderEpoch === this.epoch &&
      (previous === undefined || previous.committedOrderEpoch === this.epoch)
    )
      return previous === undefined || entry.committedRank < previous.committedRank;
    const positions = (this.#positions[band] ??= this.index(band));
    const current = this.firstPosition(entry, positions);
    const next = previous === undefined ? undefined : this.firstPosition(previous, positions);
    const count = entry.group === null ? entry.paths.length : 1;
    return (
      current !== undefined &&
      (previous === undefined || (next !== undefined && current + count <= next))
    );
  }

  public invalidate(): void {
    delete this.#positions.content;
    delete this.#positions.highlight;
  }

  public release(): void {
    this.invalidate();
    delete this.#previous.content;
    delete this.#previous.highlight;
  }

  public memoryUsage(): number {
    return (this.#positions.content?.size ?? 0) * 32 + (this.#positions.highlight?.size ?? 0) * 32;
  }

  private index(band: RenderBand): Map<Node, number> {
    // The scene owns this SVG band; one bounded sibling snapshot avoids repeated native reorders.
    // eslint-disable-next-line no-restricted-syntax -- This one bounded scan reads the scene-owned SVG band.
    const nodes = this.dom.group(band).childNodes;
    const positions = new Map<Node, number>();
    const count = nodes.length;
    for (let index = 0; index < count; index += 1) {
      const node = nodes[index];
      if (node !== undefined) positions.set(node, index);
    }
    return positions;
  }

  private firstPosition(
    entry: MountedSceneElement,
    positions: ReadonlyMap<Node, number>,
  ): number | undefined {
    const first = positions.get(firstPath(entry));
    if (first === undefined) return undefined;
    if (entry.group === null) {
      for (let index = 1; index < entry.paths.length; index += 1) {
        if (positions.get(entry.paths[index]!.node) !== first + index) return undefined;
      }
    }
    return first;
  }
}

/** Publishes an already bounded, ordered batch and returns its newly visible IDs. */
export function publishVisibilityRun(
  run: PendingMutationRun,
  options: PublicationOptions,
  epoch: number,
  retainedOrderPreserved: boolean,
): string[] {
  const ids: string[] = [];
  let fragment: DocumentFragment | undefined;
  let hasPendingNodes = false;
  const flush = (successor: MountedSceneElement | undefined): void => {
    if (!hasPendingNodes || fragment === undefined) return;
    options.dom
      .group(run.band)
      .insertBefore(fragment, successor === undefined ? null : firstPath(successor));
    options.instrumentation.domFragmentRuns += 1;
    hasPendingNodes = false;
  };
  for (let index = run.count - 1; index >= 0; index -= 1) {
    const entry = run.entries[index];
    if (entry === undefined) continue;
    const connectedRevisit = run.entrants[index]
      ? commitPublishedEntry(entry, run, options, epoch)
      : false;
    if (run.entrants[index]) {
      ids.push(entry.id);
    } else {
      commitMountedEntry(entry, run, options, epoch);
    }
    if (connectedRevisit || (retainedOrderPreserved && !run.entrants[index])) {
      // Rank shifts can mark retained nodes dirty without changing their relative DOM order.
      flush(entry);
      continue;
    }
    fragment ??= createFragment(options.dom.ownerDocument);
    appendElementToFragment(entry, fragment);
    hasPendingNodes = true;
    if (!run.entrants[index]) options.instrumentation.domReorders += 1;
    flushCachedSuccessor(entry, run.entries[index - 1] ?? run.successor, options, flush);
  }
  flush(run.successor);
  return ids;
}

function flushCachedSuccessor(
  entry: MountedSceneElement,
  next: MountedSceneElement | undefined,
  options: PublicationOptions,
  flush: (successor: MountedSceneElement) => void,
): void {
  const successor = options.detachedCache?.successor(entry);
  if (
    successor !== undefined &&
    (next === undefined ||
      (options.store.get(successor.id)?.rank ?? successor.rank) <
        (options.store.get(next.id)?.rank ?? next.rank))
  )
    flush(successor);
}

export function publishVisibilityRuns(frame: {
  readonly runs: readonly PendingMutationRun[];
  readonly count: number;
  readonly options: PublicationOptions;
  readonly epoch: number;
  readonly atomicPreserveRetainedOrder?: boolean | undefined;
  readonly output: string[];
  readonly entrants?: Map<string, MountedSceneElement>;
}): void {
  frame.output.length = 0;
  for (let index = 0; index < frame.count; index += 1) {
    const run = frame.runs[index];
    if (run === undefined) continue;
    frame.output.push(
      ...publishVisibilityRun(
        run,
        frame.options,
        frame.epoch,
        frame.atomicPreserveRetainedOrder ?? run.preserveRetainedOrder,
      ),
    );
    if (frame.entrants === undefined) continue;
    for (let item = 0; item < run.count; item += 1) {
      const entry = run.entries[item];
      if (entry !== undefined) frame.entrants.delete(entry.id);
      run.entries[item] = undefined;
    }
    run.count = 0;
    run.successor = undefined;
  }
}

interface ExitPublication {
  readonly exitIds: readonly string[];
  exitIndex: number;
}
interface ExitOptions extends PublicationOptions {
  readonly visibility: { contains(id: string): boolean; releaseId(id: string): void };
  readonly pathCache: {
    invalidate(id: string): void;
    retain(id: string, version: number, parts: MountedSceneElement["pathParts"]): void;
  };
  readonly isExitReady?: (id: string, now: number) => boolean;
}

function retainVisibilityExit(
  entry: MountedSceneElement,
  record: ReturnType<SceneStorePort["get"]>,
  options: ExitOptions,
): "retained" | "pending" | undefined {
  if (
    record === undefined ||
    entry.geometryVersion !== record.geometryVersion ||
    entry.detachedPathCount > 0 ||
    entry.displayedPathParts !== entry.pathParts
  )
    return undefined;
  const isNeeded = (id: string) => options.visibility.contains(id);
  if (options.detachedCache?.retainConnected(entry, options.store, isNeeded)) {
    options.pathCache.retain(entry.id, entry.geometryVersion, entry.pathParts);
    options.mounted.delete(entry.id);
    return "retained";
  }
  return options.detachedCache?.retentionEnabled &&
    (options.detachedCache.hasPendingCleanup ||
      options.detachedCache.needsVisibleAdoption(entry, isNeeded))
    ? "pending"
    : undefined;
}

function removeVisibilityExitNode(
  entry: MountedSceneElement,
  record: ReturnType<SceneStorePort["get"]>,
  options: ExitOptions,
  finalization: {
    readonly pending: ExitPublication;
    readonly onRemoved: ((id: string) => void) | undefined;
  },
): void {
  if (!removeMountedElementNode(entry)) return;
  finalization.pending.exitIndex += 1;
  options.mounted.delete(entry.id);
  options.detachedCache?.unregisterMounted(entry.id);
  finalization.onRemoved?.(entry.id);
  if (record === undefined) {
    options.detachedCache?.invalidate(entry.id);
    options.pathCache.invalidate(entry.id);
    options.visibility.releaseId(entry.id);
  } else {
    options.pathCache.retain(entry.id, entry.geometryVersion, entry.pathParts);
    options.detachedCache?.retain(entry, (id) => options.visibility.contains(id));
  }
  options.instrumentation.domExits += 1;
}

/** Removes old paths incrementally, rechecking visibility after every retarget. */
export function removeVisibilityExits(
  pending: ExitPublication,
  options: ExitOptions,
  frame: {
    readonly deadline: number;
    readonly now: () => number;
    readonly isExit: (id: string) => boolean;
    readonly onSkipped?: (id: string) => void;
    readonly onRemoved?: (id: string) => void;
    readonly publication?: ScenePublicationBudget;
    readonly retainedOnly?: boolean;
  },
): boolean {
  let visitedNodes = 0;
  let removedNodes = 0;
  while (pending.exitIndex < pending.exitIds.length) {
    if (
      (frame.publication?.remainingRemovals ?? 64 - removedNodes) <= 0 ||
      (visitedNodes > 0 && frame.now() >= frame.deadline)
    )
      return false;
    const id = pending.exitIds[pending.exitIndex];
    const entry = id === undefined ? undefined : options.mounted.get(id);
    visitedNodes += 1;
    if (entry === undefined || !frame.isExit(entry.id)) {
      if (id !== undefined) frame.onSkipped?.(id);
      pending.exitIndex += 1;
      continue;
    }
    if (options.isExitReady?.(entry.id, frame.now()) === false) return false;
    const record = options.store.get(entry.id);
    const retention = retainVisibilityExit(entry, record, options);
    if (retention === "retained") {
      pending.exitIndex += 1;
      frame.onRemoved?.(entry.id);
      continue;
    }
    if (retention === "pending") return false;
    if (frame.retainedOnly) return false;
    removedNodes += 1;
    if (frame.publication !== undefined)
      frame.publication.remainingRemovals = (frame.publication.remainingRemovals ?? 64) - 1;
    removeVisibilityExitNode(entry, record, options, { pending, onRemoved: frame.onRemoved });
  }
  return true;
}
