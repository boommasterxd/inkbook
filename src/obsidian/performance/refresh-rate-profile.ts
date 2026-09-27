import { FRAME_WORK_SHARE } from "../../domain/scheduling/work-scheduler";
import type { RefreshRatePreferenceV2 } from "../../domain/settings";

const FIXED_REFRESH_RATES = [60, 90, 120, 144, 240] as const;
export type FixedRefreshRate = (typeof FIXED_REFRESH_RATES)[number];

export const DEFAULT_REFRESH_RATE: FixedRefreshRate = 120;

export interface RefreshRateProfile {
  readonly refreshRate: FixedRefreshRate;
  readonly frameDurationMs: number;
  readonly sliceBudgetMs: number;
}

export function refreshRateProfile(refreshRate: FixedRefreshRate): RefreshRateProfile {
  const frameDurationMs = 1_000 / refreshRate;
  return {
    refreshRate,
    frameDurationMs,
    sliceBudgetMs: frameDurationMs * FRAME_WORK_SHARE,
  };
}

export function fixedRefreshRate(
  preference: RefreshRatePreferenceV2,
): FixedRefreshRate | undefined {
  return preference === "auto" ? undefined : preference;
}

export function conservativeRefreshRate(measuredRate: number): FixedRefreshRate {
  if (!Number.isFinite(measuredRate) || measuredRate <= 0) return DEFAULT_REFRESH_RATE;
  for (const refreshRate of FIXED_REFRESH_RATES) {
    if (measuredRate <= refreshRate * 1.03) return refreshRate;
  }
  return 240;
}
