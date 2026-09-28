import type { RenderBand } from "../../domain/commands/render-bands";
import type { MountedSceneElement } from "./mounted-element";
import type { SceneDom } from "./scene-dom";
import type { ScenePathCache } from "./path-cache";
import type { MutableSceneInstrumentation, SceneStorePort } from "./types";
import type { PendingMutationRun, RetainedDomOrder } from "./visibility-publication";
import type { SceneVisibilityState, VisibilityResult } from "./visibility-state";

export interface SceneVisibilityReconcilerOptions {
  readonly dom: SceneDom;
  readonly instrumentation: MutableSceneInstrumentation;
  readonly mounted: Map<string, MountedSceneElement>;
  readonly isExitReady?: (id: string, now: number) => boolean;
  readonly orderDirty: Record<RenderBand, Set<string>>;
  readonly pathCache: ScenePathCache;
  readonly store: SceneStorePort;
  readonly visibility: SceneVisibilityState;
}

export interface ReconciliationCursor {
  band: RenderBand;
  index: number;
  run: PendingMutationRun | undefined;
  successor: MountedSceneElement | undefined;
}

export interface PendingReconciliation {
  readonly delta?: {
    readonly ids: readonly string[];
    index: number;
    readonly successors: Partial<
      Record<RenderBand, { index: number; entry: MountedSceneElement | undefined }>
    >;
    search: { id: string; index: number } | undefined;
  };
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

export interface ReconciliationResult {
  readonly committedVisibility?: VisibilityResult;
  readonly orderProofEpoch?: number;
  readonly pending: boolean;
  readonly newlyMountedIds: readonly string[];
}
