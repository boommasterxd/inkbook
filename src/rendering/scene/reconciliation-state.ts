import type { RenderBand } from "../../domain/commands/render-bands";
import type { MountedSceneElement } from "./mounted-element";
import type { PendingMutationRun, RetainedDomOrder } from "./visibility-publication";
import type { VisibilityResult } from "./visibility-state";

export interface ReconciliationCursor {
  band: RenderBand;
  index: number;
  run: PendingMutationRun | undefined;
  successor: MountedSceneElement | undefined;
}

export interface PendingReconciliation {
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
  readonly pending: boolean;
  readonly newlyMountedIds: readonly string[];
}
