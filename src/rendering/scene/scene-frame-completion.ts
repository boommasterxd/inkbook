import type { SceneFrameWorkResult } from "./scene-frame-work";

export function canCompleteSceneFrame(work: SceneFrameWorkResult, pendingQuery: boolean): boolean {
  return !work.pendingVisibility && !work.backgroundDeferred && !pendingQuery;
}

export function needsAnotherSceneFrame(
  work: SceneFrameWorkResult,
  pendingQuery: boolean,
  pendingMotion: boolean,
  pendingExitCleanup: boolean,
): boolean {
  return (
    work.pendingVisibility ||
    work.backgroundDeferred ||
    work.pendingPreview ||
    work.pendingFades ||
    pendingQuery ||
    pendingMotion ||
    pendingExitCleanup
  );
}
