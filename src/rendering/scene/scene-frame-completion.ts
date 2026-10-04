import type { SceneFrameWorkResult } from "./scene-frame-work";
import type { SceneFrameScheduler } from "./scene-frame-scheduler";
import type { SceneCommitCoordinator } from "./scene-commit-coordinator";

function canCompleteSceneFrame(work: SceneFrameWorkResult, pendingQuery: boolean): boolean {
  return !work.pendingVisibility && !work.backgroundDeferred && !pendingQuery;
}

function needsAnotherSceneFrame(
  work: SceneFrameWorkResult,
  pendingQuery: boolean,
  pendingMotion: boolean,
  pendingExitCleanup: boolean,
): boolean {
  return (
    (work.pendingVisibility && work.waitingForPaths !== true) ||
    work.backgroundDeferred ||
    work.pendingPreview ||
    work.pendingFades ||
    pendingQuery ||
    pendingMotion ||
    pendingExitCleanup
  );
}

/** Completes only the authoritative target and keeps remaining scene queues admitted. */
export function completeSceneFrame(
  work: SceneFrameWorkResult,
  pending: { readonly query: boolean; readonly motion: boolean; readonly exits: boolean },
  commits: SceneCommitCoordinator,
  frames: SceneFrameScheduler,
): void {
  if (canCompleteSceneFrame(work, pending.query)) commits.completeFrame();
  if (needsAnotherSceneFrame(work, pending.query, pending.motion, pending.exits)) frames.schedule();
}
