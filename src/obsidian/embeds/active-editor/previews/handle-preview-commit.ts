import type { PointV1 } from "../../../../domain/schema/public";
import type { SnappingSettingsV1 } from "../../../../domain/settings/types";
import type { ToolSystemCursor } from "../../../../editor/input/tool-cursor";
import type { PointerSample } from "../../../../editor/input/index";
import type {
  ConnectedSelectionPreviewSession,
  SelectedElementGeometry,
} from "../../../../editor/selection/public";
import type { SelectionScalePreviewPlan } from "./selection-scale-preview";
import type {
  OrientedSelectionFrame,
  SelectionFrameSession,
  SelectionHandleSession,
} from "../../../../editor/selection/public";
import type { ActiveEditorHistory } from "../history";
import type { PreparedElementHistory } from "../prepared-element-history";
import type { HandleInteractionRenderer } from "./handle-presentation";
import { commitPreviewReplacement } from "./preview-replacement-commit";

export interface ActiveHandleGesture {
  readonly selectionSource: ReadonlySet<string>;
  readonly cursor: ToolSystemCursor;
  readonly connectedPreview: ConnectedSelectionPreviewSession;
  readonly connectedTransformIds: readonly string[];
  readonly grabOffset: PointV1;
  readonly pointerId: number;
  readonly pointerType: PointerSample["pointerType"];
  readonly selected: readonly SelectedElementGeometry[];
  readonly frame: OrientedSelectionFrame | null;
  readonly selectedIds: ReadonlySet<string>;
  readonly scalePreview: SelectionScalePreviewPlan;
  readonly session: SelectionHandleSession;
  readonly snapping: SnappingSettingsV1 | undefined;
}

interface HandleCommitOptions {
  readonly active: Pick<ActiveHandleGesture, "frame" | "selectedIds" | "session">;
  readonly history: ActiveEditorHistory;
  readonly layout: { finish(committed: boolean, previewMaximumBottom?: number): void } | undefined;
  readonly preparedHistory: PreparedElementHistory;
  readonly renderer: HandleInteractionRenderer;
  readonly selectionFrames: SelectionFrameSession;
  readonly previewMaximumBottom: number | undefined;
}

/** Transfers the gesture snapshot to atomic history preparation while retaining its preview. */
export function commitHandlePreview(options: HandleCommitOptions, onSettled?: () => void): boolean {
  const { active } = options;
  const transform = active.session.preview.transform;
  const requiresFramePreparation =
    transform?.kind === "scale" && active.frame !== null && active.selectedIds.size > 1;
  const commit = requiresFramePreparation
    ? ({ status: "time-sliced-required" } as const)
    : active.session.prepareCommit();
  if (commit.status === "ready") {
    const committed = commitPreviewReplacement({
      effect:
        active.session.preview.transform?.kind === "scale"
          ? undefined
          : options.selectionFrames.transition(active.frame, active.session.preview.transform),
      history: options.history,
      motion: options.renderer,
      previous: commit.previous,
      replacements: commit.replacements,
    });
    options.layout?.finish(committed, options.previewMaximumBottom);
  } else if (commit.status === "time-sliced-required") {
    const accepted = options.preparedHistory.commitHandle(
      active.session,
      (committed) => options.layout?.finish(committed, options.previewMaximumBottom),
      (replacements, scheduler) =>
        active.session.preview.transform?.kind === "scale"
          ? options.selectionFrames.rebaseTimeSliced(
              active.frame,
              replacements,
              scheduler,
              active.selectedIds,
            )
          : options.selectionFrames.transition(active.frame, active.session.preview.transform),
      onSettled,
    );
    if (!accepted) options.layout?.finish(false);
    return accepted;
  } else {
    options.layout?.finish(false);
  }
  return false;
}
