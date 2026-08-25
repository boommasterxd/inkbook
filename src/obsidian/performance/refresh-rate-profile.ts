import type { RefreshRatePreferenceV2 } from "../../domain/settings";

const FIXED_REFRESH_RATES = [60, 90, 120, 144, 240] as const;
export type FixedRefreshRate = (typeof FIXED_REFRESH_RATES)[number];

const MAIN_THREAD_SHARE = 0.55;

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
    sliceBudgetMs: frameDurationMs * MAIN_THREAD_SHARE,
  };
}

export function fixedRefreshRate(
  preference: RefreshRatePreferenceV2,
): FixedRefreshRate | undefined {
  return preference === "auto" ? undefined : preference;
}

export function conservativeRefreshRate(measuredRate: number): FixedRefreshRate {
  if (!Number.isFinite(measuredRate) || measuredRate <= 0) return 240;
  for (const refreshRate of FIXED_REFRESH_RATES) {
    if (measuredRate <= refreshRate * 1.03) return refreshRate;
  }
  return 240;
}
