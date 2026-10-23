import type { RenderBand } from "../../../domain/commands/render-bands";
import type { MountedSceneElement } from "../content/mounted-element";
import type { SceneDom } from "../scene-dom";
import type { ScenePathCache } from "../content/path-cache";
import type { MutableSceneInstrumentation, SceneElementRecord, SceneStorePort } from "../types";
import type { PendingMutationRun, RetainedDomOrder } from "./visibility-publication";
import type { SceneVisibilityState, VisibilityResult } from "../visibility/visibility-state";
import type { SceneEntrantPriority } from "../visibility/scene-entrant-priority";
import type { DetachedSceneElementCache } from "../content/detached-element-cache";
import type { VisibleMountOrder } from "./visible-mount-order";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { SvgPathPart } from "../../../domain/geometry/svg-path-part";
import type { VisibilityExitReadiness } from "./visibility-exit-readiness";

export interface ScenePreparationOptions {
  readonly onPathsReady?: () => void;
  readonly detachedCache?: DetachedSceneElementCache;
  readonly scheduler?: WorkScheduler;
  readonly takePreparedPath?: (record: SceneElementRecord) => readonly SvgPathPart[] | undefined;
  readonly onMount?: (entry: MountedSceneElement) => void;
  readonly onUnmount?: (id: string) => void;
}

export interface SceneVisibilityReconcilerOptions extends ScenePreparationOptions {
  readonly dom: SceneDom;
  readonly instrumentation: MutableSceneInstrumentation;
  readonly mounted: Map<string, MountedSceneElement>;
  readonly isExitReady?: (id: string, now: number) => boolean;
  readonly exitReadyAt?: (id: string) => number;
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
  delta?: {
    phase: "warm" | "deferred" | "paths";
    ids: string[];
    index: number;
    deferred: string[];
    readonly priority?: SceneEntrantPriority;
    readonly order?: VisibleMountOrder;
    publishedOrder?: VisibleMountOrder;
    publicationPositions?: Map<string, number>;
    readonly successors: Partial<
      Record<RenderBand, { start: number; index: number; entry: MountedSceneElement | undefined }>
    >;
    search: { id: string; index: number; low: number } | undefined;
  };
  readonly entrants: Map<string, MountedSceneElement>;
  readonly exitIds: string[];
  exitIndex: number;
  published: boolean;
  progressive: boolean;
  targetPublished: boolean;
  retainedOrderPreserved: boolean;
  readonly exits: MapIterator<[string, MountedSceneElement]>;
  readonly scanExits: boolean;
  exitScanComplete: boolean;
  exitOrderPrepared: boolean;
  exitReadiness?: VisibilityExitReadiness;
  cleanupFirst: boolean;
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
