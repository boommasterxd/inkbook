import { performanceMode } from "../timing-budget";

export function createFallbackDeadlineClock(): () => number {
  if (performanceMode() !== "contracts") return () => performance.now();
  let reads = 0;
  // Each real scheduler clock read costs 0.05 virtual ms. This is a checkpoint
  // cost model, not a device-speed estimate; timing measurements use a separate clock.
  return () => ++reads / 20;
}
