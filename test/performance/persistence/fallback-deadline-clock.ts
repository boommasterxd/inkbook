import { performanceMode } from "../timing-budget";

export function createFallbackDeadlineClock(): () => number {
  if (performanceMode() === "reference") return () => performance.now();
  let reads = 0;
  // Each real scheduler clock read costs 0.05 virtual ms. This is a checkpoint
  // cost model, not a device-speed estimate; CPU measurements use another clock.
  return () => ++reads / 20;
}
