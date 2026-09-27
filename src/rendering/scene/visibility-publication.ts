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

export interface PendingMutationRun {
  band: RenderBand;
  capacity: number;
  count: number;
  readonly entrants: boolean[];
  readonly entries: Array<MountedSceneElement | undefined>;
  successor: MountedSceneElement | undefined;
}

interface PublicationOptions {
  readonly dom: SceneDom;
  readonly instrumentation: MutableSceneInstrumentation;
  readonly mounted: Map<string, MountedSceneElement>;
  readonly store: SceneStorePort;
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
    entry.rank = options.store.get(entry.id)?.rank ?? Number.MAX_SAFE_INTEGER;
    entry.committedRank = entry.rank;
    entry.committedOrderEpoch = epoch;
    entry.band = run.band;
    if (retainedOrderPreserved && !run.entrants[index]) {
      // Rank shifts can mark retained nodes dirty without changing their relative DOM order.
      flush(entry);
      continue;
    }
    fragment ??= createFragment(options.dom.ownerDocument);
    appendElementToFragment(entry, fragment);
    hasPendingNodes = true;
    if (run.entrants[index]) {
      options.mounted.set(entry.id, entry);
      ids.push(entry.id);
      options.instrumentation.domEntrants += 1;
    } else options.instrumentation.domReorders += 1;
  }
  flush(run.successor);
  return ids;
}

interface ExitPublication {
  readonly exitIds: readonly string[];
  exitIndex: number;
}
interface ExitOptions extends PublicationOptions {
  readonly visibility: { releaseId(id: string): void };
  readonly pathCache: {
    invalidate(id: string): void;
    retain(id: string, version: number, parts: MountedSceneElement["pathParts"]): void;
  };
  readonly isExitReady?: (id: string, now: number) => boolean;
}

/** Removes old paths incrementally, rechecking visibility after every retarget. */
export function removeVisibilityExits(
  pending: ExitPublication,
  options: ExitOptions,
  frame: {
    readonly deadline: number;
    readonly now: () => number;
    readonly isExit: (id: string) => boolean;
  },
): boolean {
  let visitedNodes = 0;
  let removedNodes = 0;
  while (pending.exitIndex < pending.exitIds.length) {
    if (
      removedNodes >= 64 ||
      visitedNodes >= 4096 ||
      (visitedNodes > 0 && frame.now() >= frame.deadline)
    )
      return false;
    const id = pending.exitIds[pending.exitIndex];
    const entry = id === undefined ? undefined : options.mounted.get(id);
    visitedNodes += 1;
    if (entry === undefined || !frame.isExit(entry.id)) {
      pending.exitIndex += 1;
      continue;
    }
    if (options.isExitReady?.(entry.id, frame.now()) === false) return false;
    removedNodes += 1;
    if (!removeMountedElementNode(entry)) continue;
    pending.exitIndex += 1;
    options.mounted.delete(entry.id);
    const record = options.store.get(entry.id);
    if (record === undefined) {
      options.pathCache.invalidate(entry.id);
      options.visibility.releaseId(entry.id);
    } else options.pathCache.retain(entry.id, entry.geometryVersion, entry.pathParts);
    options.instrumentation.domExits += 1;
  }
  return true;
}
