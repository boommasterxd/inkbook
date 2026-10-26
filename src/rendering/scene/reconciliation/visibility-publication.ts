import type { RenderBand } from "../../../domain/commands/render-bands";
import {
  appendElementToFragment,
  createFragment,
  firstPath,
  removeMountedElementNode,
  type MountedSceneElement,
} from "../content/mounted-element";
import type { SceneDom } from "../scene-dom";
import type { MutableSceneInstrumentation, SceneStorePort } from "../types";
import type { MountSlice, MountYieldReason, ScenePublicationBudget } from "./mount-slice";
import type { DetachedSceneElementCache } from "../content/detached-element-cache";
import type { VisibilityExitReadiness } from "./visibility-exit-readiness";
import {
  resolveSceneRootParent,
  resolveSceneRootTarget,
  type SceneRootPlacement,
} from "./root-placement";

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
  readonly placement?: SceneRootPlacement;
  readonly onMount?: (entry: MountedSceneElement) => void;
  readonly onUnmount?: (id: string) => void;
  readonly detachedCache?: DetachedSceneElementCache | undefined;
  readonly dom: SceneDom;
  readonly instrumentation: MutableSceneInstrumentation;
  readonly mounted: Map<string, MountedSceneElement>;
  readonly store: SceneStorePort;
}

/** Defers fragment allocation until a publication actually needs multiple roots. */
class PendingPublicationNode {
  #node: Node | undefined;
  #fragment: DocumentFragment | undefined;
  #last: MountedSceneElement | undefined;
  #parent: SVGGElement | undefined;

  public constructor(private readonly options: PublicationOptions) {}

  public append(entry: MountedSceneElement): void {
    const parent = resolveSceneRootParent(entry, this.options);
    if (this.#parent !== undefined && this.#parent !== parent) this.flush(entry);
    this.#parent = parent;
    this.#last = entry;
    if (this.#node === undefined && mountedRootCount(entry) === 1) {
      this.#node = firstPath(entry);
      entry.detachedPathCount = 0;
      return;
    }
    this.#fragment ??= createFragment(this.options.dom.ownerDocument);
    if (this.#node !== undefined && this.#node !== this.#fragment)
      this.#fragment.append(this.#node);
    appendElementToFragment(entry, this.#fragment);
    this.#node = this.#fragment;
  }

  public flush(successor: MountedSceneElement | undefined): void {
    if (this.#node === undefined || this.#last === undefined) return;
    const target = resolveSceneRootTarget(this.#last, successor, this.options);
    if (target.parent !== this.#parent)
      throw new Error("Scene root placement changed during an atomic publication.");
    target.parent.insertBefore(this.#node, target.before);
    this.#node = undefined;
    this.#last = undefined;
    this.#parent = undefined;
    this.options.instrumentation.domFragmentRuns += 1;
  }
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
  options.mounted.set(entry.id, entry);
  options.onMount?.(entry);
  if (!connected) options.instrumentation.domEntrants += 1;
  options.instrumentation.domRootsPublished += roots;
  return connected;
}

/** A stable delta run has one exact mounted physical successor. */
export function publishStableEntrantRun(
  run: PendingMutationRun,
  options: PublicationOptions,
  epoch: number,
): string[] {
  const ids: string[] = [];
  const publication = new PendingPublicationNode(options);
  for (let index = run.count - 1; index >= 0; index -= 1) {
    const entry = run.entries[index];
    if (entry === undefined) continue;
    const connected = commitPublishedEntry(entry, run, options, epoch);
    ids.push(entry.id);
    if (connected) continue;
    publication.append(entry);
  }
  publication.flush(run.successor);
  return ids;
}

export function mountedRootCount(entry: MountedSceneElement): number {
  return entry.group === null ? entry.paths.length : 1;
}

/** Existing mounted roots have already paid their browser publication cost. */
export function publicationRootCount(entry: MountedSceneElement): number {
  return firstPath(entry).parentNode === null ? mountedRootCount(entry) : 0;
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

/** Checks retained paint order across element roots and order-preserving SVG wrappers. */
export class RetainedDomOrder {
  readonly #previous: Partial<Record<RenderBand, MountedSceneElement>> = {};

  public constructor(
    private readonly dom: Pick<SceneDom, "group">,
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
    const last = this.lastContiguousRoot(entry, band);
    if (last === undefined) return false;
    if (previous === undefined) return true;
    const next = firstPath(previous);
    if (this.lastContiguousRoot(previous, band) === undefined) return false;
    const position = last.compareDocumentPosition(next);
    // Following alone preserves paint order; disconnected and ancestor relations do not.
    return (position & (1 | 8 | 16)) === 0 && (position & 4) !== 0;
  }

  public invalidate(): void {
    // Native comparisons observe the current tree without a retained position snapshot.
  }

  public release(): void {
    this.invalidate();
    delete this.#previous.content;
    delete this.#previous.highlight;
  }

  public memoryUsage(): number {
    return 0;
  }

  private lastContiguousRoot(entry: MountedSceneElement, band: RenderBand): SVGElement | undefined {
    let last = firstPath(entry);
    if (!this.dom.group(band).contains(last)) return undefined;
    if (entry.group === null) {
      for (let index = 1; index < entry.paths.length; index += 1) {
        const next = entry.paths[index]!.node;
        // eslint-disable-next-line no-restricted-syntax -- Only this element's owned multipart roots are inspected.
        if (last.nextSibling !== next) return undefined;
        last = next;
      }
    }
    return last;
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
  const publication = new PendingPublicationNode(options);
  const flush = (successor: MountedSceneElement | undefined): void => {
    publication.flush(successor);
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
    publication.append(entry);
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
  readonly exitReadiness?: VisibilityExitReadiness;
}
interface ExitOptions extends PublicationOptions {
  readonly visibility: { contains(id: string): boolean; releaseId(id: string): void };
  readonly pathCache: {
    invalidate(id: string): void;
    retain(id: string, version: number, parts: MountedSceneElement["pathParts"]): void;
  };
  readonly isExitReady?: (id: string, now: number) => boolean;
  readonly exitReadyAt?: (id: string) => number;
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
  finalization.pending.exitReadiness?.consume(entry.id);
  options.mounted.delete(entry.id);
  options.onUnmount?.(entry.id);
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

/** Repairs protected multipart roots at their existing anchor within frame publication admission. */
function restoreProtectedExit(
  entry: MountedSceneElement,
  options: ExitOptions,
  publication: ScenePublicationBudget | undefined,
): boolean {
  if (entry.detachedPathCount === 0) return true;
  const roots = mountedRootCount(entry);
  if ((publication?.remainingRoots ?? Infinity) < roots) return false;
  let anchor = firstPath(entry);
  const group = resolveSceneRootParent(entry, options);
  for (let index = entry.paths.length - 1; index >= 0; index -= 1) {
    const node = entry.paths[index]!.node;
    group.insertBefore(node, anchor);
    anchor = node;
  }
  entry.detachedPathCount = 0;
  if (publication !== undefined) publication.remainingRoots -= roots;
  options.instrumentation.domRootsPublished += roots;
  options.instrumentation.domFragmentRuns += roots;
  return true;
}

/** Rechecks readiness when preview protection changed after initial classification. */
function visibilityExitReadiness(
  entry: MountedSceneElement,
  pending: ExitPublication,
  options: ExitOptions,
  now: number,
): "ready" | "retry" | "wait" {
  if (options.isExitReady?.(entry.id, now) !== false) return "ready";
  const finish = options.exitReadyAt?.(entry.id);
  if (
    pending.exitReadiness === undefined ||
    finish === undefined ||
    finish <= now ||
    entry.detachedPathCount > 0
  )
    return "wait";
  pending.exitReadiness.update(entry.id, finish);
  return "retry";
}

function skipVisibilityExit(
  id: string | undefined,
  pending: ExitPublication,
  onSkipped: ((id: string) => void) | undefined,
): void {
  if (id !== undefined) {
    onSkipped?.(id);
    pending.exitReadiness?.consume(id);
  }
  pending.exitIndex += 1;
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
    if (pending.exitReadiness?.select(frame) === false) return false;
    const id = pending.exitIds[pending.exitIndex];
    const entry = id === undefined ? undefined : options.mounted.get(id);
    visitedNodes += 1;
    if (entry === undefined || !frame.isExit(entry.id)) {
      if (entry !== undefined && !restoreProtectedExit(entry, options, frame.publication))
        return false;
      skipVisibilityExit(id, pending, frame.onSkipped);
      continue;
    }
    const readiness = visibilityExitReadiness(entry, pending, options, frame.now());
    if (readiness === "wait") return false;
    if (readiness === "retry") continue;
    const record = options.store.get(entry.id);
    removedNodes += 1;
    if (frame.publication !== undefined)
      frame.publication.remainingRemovals = (frame.publication.remainingRemovals ?? 64) - 1;
    removeVisibilityExitNode(entry, record, options, { pending, onRemoved: frame.onRemoved });
  }
  return true;
}
