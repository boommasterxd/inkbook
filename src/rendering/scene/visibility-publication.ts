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

/** Publishes an already bounded, ordered batch and returns its newly visible IDs. */
export function publishVisibilityRun(
  run: PendingMutationRun,
  options: PublicationOptions,
  epoch: number,
  preserveOrder: boolean,
): string[] {
  const ids: string[] = [];
  const fragment = preserveOrder ? undefined : createFragment(options.dom.ownerDocument);
  for (let index = run.count - 1; index >= 0; index -= 1) {
    const entry = run.entries[index];
    if (entry === undefined) continue;
    entry.rank = options.store.get(entry.id)?.rank ?? Number.MAX_SAFE_INTEGER;
    entry.committedRank = entry.rank;
    entry.committedOrderEpoch = epoch;
    if (fragment === undefined) continue;
    appendElementToFragment(entry, fragment);
    if (run.entrants[index]) {
      options.mounted.set(entry.id, entry);
      ids.push(entry.id);
      options.instrumentation.domEntrants += 1;
    } else options.instrumentation.domReorders += 1;
  }
  if (fragment !== undefined) {
    options.dom
      .group(run.band)
      .insertBefore(fragment, run.successor === undefined ? null : firstPath(run.successor));
    options.instrumentation.domFragmentRuns += 1;
  }
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
