import type { InkElementV1 } from "../../../domain/schema/public";
import type { SelectionFrameHistoryEffect } from "../../../editor/selection/public";

import type { ActiveEditorHistory } from "./history";

interface PreviewReplacementMotion {
  beginPreviewCommit?(): {
    arm(ids: readonly string[]): boolean;
    cancel(): void;
  };
  suppressMotionForNextDelta(ids: readonly string[]): void;
}

interface PreviewReplacementCommitInput {
  readonly effect: SelectionFrameHistoryEffect | undefined;
  readonly history: ActiveEditorHistory;
  readonly motion: PreviewReplacementMotion;
  readonly previous: readonly InkElementV1[];
  readonly replacements: readonly InkElementV1[];
}

export function commitPreviewReplacement(input: PreviewReplacementCommitInput): boolean {
  const ids = input.previous.map(({ id }) => id);
  const handoff = input.motion.beginPreviewCommit?.();
  if (handoff === undefined) input.motion.suppressMotionForNextDelta(ids);
  let committed = false;
  try {
    if (handoff !== undefined && !handoff.arm(ids)) return false;
    committed = input.history.replace(input.previous, input.replacements, input.effect);
    return committed;
  } finally {
    if (!committed) handoff?.cancel();
  }
}
