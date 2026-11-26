const SUPPORTED_REFRESH_RATES = [60, 90, 120, 144, 240] as const;
const MAIN_THREAD_FRAME_SHARE = 0.55;

declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

const refreshRate = readRefreshRate();

/** Simulated scheduling inputs, not measurements of execution speed. */
export const INTERACTION_REFRESH_PROFILE = Object.freeze({
  refreshRate,
  frameDurationMs: 1_000 / refreshRate,
  interruptibleSliceDeadlineMs: (1_000 / refreshRate) * MAIN_THREAD_FRAME_SHARE,
});

function readRefreshRate(): (typeof SUPPORTED_REFRESH_RATES)[number] {
  const configured = process.env["INKBOOK_PERFORMANCE_REFRESH_RATE"];
  if (configured === undefined) return 120;
  const candidate = Number(configured);
  const supported = SUPPORTED_REFRESH_RATES.find((value) => value === candidate);
  if (supported === undefined) {
    throw new TypeError(`Unsupported performance refresh rate: ${configured}`);
  }
  return supported;
}
