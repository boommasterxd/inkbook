const SUPPORTED_REFRESH_RATES = [60, 90, 120, 144, 240] as const;
const MAIN_THREAD_FRAME_SHARE = 0.55;

declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

const refreshRate = readRefreshRate();

/** Simulated scheduling inputs, not measurements of execution speed. */
export const INTERACTION_REFRESH_PROFILE = Object.freeze({
  refreshRate,
  frameDurationMs: 1_000 / refreshRate,
  interruptibleSliceDeadlineMs: (1_000 / refreshRate) * MAIN_THREAD_FRAME_SHARE,
  sampleCount: 600,
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

export function runInteractionFrames(
  run: (frame: number) => void,
  count: number = INTERACTION_REFRESH_PROFILE.sampleCount,
): void {
  if (!Number.isInteger(count) || count < 0 || count > 0xffff_ffff) {
    throw new RangeError("Invalid interaction frame count.");
  }
  for (let frame = 0; frame < count; frame += 1) run(frame);
}
