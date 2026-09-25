import type { InkElementV1, PointV1 } from "../../../domain/schema/public";
import type { ToolDefaultsV1 } from "../../../domain/settings/types";
import type { ElementStore } from "../../../domain/store/public";
import type { GesturePreviewStart } from "../../../editor/gestures/public";
import type { SelectionFrameSession } from "../../../editor/selection/public";

import type { ActiveEditorHistory } from "./history";
import type { PreparedElementHistory } from "./prepared-element-history";
import type { ElementSceneStore } from "./scene-store";

interface SelectionPreviewRenderer {
  beginPreviewCommit?(): {
    arm(ids: readonly string[]): boolean;
    cancel(): void;
  };
  clearElementPreviews?(): void;
  clearPreviewTransforms(): void;
  flushPointerFeedbackFrame?(): void;
  setElementPreviews?(elements: readonly InkElementV1[], version: number): void;
  setOverlayPath(d: string | null): void;
  setSelectionOverlayPath?(
    d: string | null,
    fill?: "accent" | "none",
    handles?: string | null,
  ): void;
  setSnapMarkerPath?(d: string | null): void;
  setPreviewTransform(ids: readonly string[], transform: string | null, version: number): void;
  suppressMotionForNextDelta(ids: readonly string[]): void;
}

export interface SelectionEdgeDragPort {
  begin(onViewportChanged?: () => void): void;
  finish(committed: boolean, previewMaximumBottom?: number): void;
  stop(): void;
  update(screenPointer: PointV1): void;
  updatePreviewBottom(maximumBottom: number): void;
}

export interface SelectionPreviewFrameScheduler {
  cancelAnimationFrame(handle: number): void;
  requestAnimationFrame(callback: FrameRequestCallback): number;
}

export interface SelectionPreviewOptions {
  readonly history: ActiveEditorHistory;
  readonly pageToScreen: (point: PointV1) => PointV1;
  readonly pageToViewport?: (point: PointV1) => PointV1;
  readonly viewportToPage?: (point: PointV1) => PointV1;
  readonly preparedHistory: PreparedElementHistory;
  readonly renderer: SelectionPreviewRenderer;
  readonly sceneStore: ElementSceneStore;
  readonly selectionEdgeDrag?: SelectionEdgeDragPort;
  readonly selection: () => ReadonlySet<string>;
  readonly selectionSignal?: AbortSignal;
  readonly selectionWorkBudget?: {
    readonly now: () => number;
    readonly sliceBudgetMs: () => number;
  };
  readonly selectionFrames?: SelectionFrameSession;
  readonly connectionSnapping?: boolean | (() => boolean);
  readonly frameScheduler?: SelectionPreviewFrameScheduler;
  readonly selectionDefaults?: ToolDefaultsV1["select"];
  readonly setSelection: (selection: ReadonlySet<string>) => void;
  readonly start: GesturePreviewStart;
  readonly store: ElementStore;
  readonly zoom?: () => number;
}
