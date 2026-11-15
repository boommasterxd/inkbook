export { ElementStore } from "./element-store";
export {
  assertElementUnlocked,
  LockedElementMutationError,
  withElementLock,
} from "./records/element-lock";
export type {
  AppliedElementMutation,
  ElementMutation,
  ElementReplacementHistoryData,
  PreparedElementMutation,
  PreparedElementMutationResult,
  PreparedElementReplacement,
  PreparedElementReplacementResult,
  StoreDelta,
  StoreSliceScheduler,
} from "./types";
