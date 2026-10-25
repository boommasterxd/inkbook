import type {
  OrientedSelectionFrame,
  SelectionFrameSession,
  SelectionHandleSession,
} from "../../../../editor/selection/public";
import type { InkElementV1 } from "../../../../domain/schema/public";
import type { ActiveEditorHistory } from "../history";
import type { PreparedElementHistory } from "../prepared-element-history";
import type { HandleInteractionRenderer } from "./handle-presentation";
import { commitPreviewReplacement } from "./preview-replacement-commit";

interface HandleCommitOptions {
  readonly active: {
    readonly frame: OrientedSelectionFrame | null;
    readonly selectedIds: ReadonlySet<string>;
    readonly session: SelectionHandleSession;
  };
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
  const commit = active.session.prepareCommit();
  const frameEffect = (replacements: readonly InkElementV1[]) =>
    active.session.preview.transform?.kind === "scale"
      ? options.selectionFrames.rebase(
          active.frame,
          replacements.filter(({ id }) => active.selectedIds.has(id)),
        )
      : options.selectionFrames.transition(active.frame, active.session.preview.transform);
  if (commit.status === "ready") {
    const committed = commitPreviewReplacement({
      effect: frameEffect(commit.replacements),
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
      frameEffect,
      onSettled,
    );
    if (!accepted) options.layout?.finish(false);
    return accepted;
  } else {
    options.layout?.finish(false);
  }
  return false;
}
