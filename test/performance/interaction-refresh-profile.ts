const SUPPORTED_REFRESH_RATES = [60, 90, 120, 144, 240] as const;
const MAIN_THREAD_FRAME_SHARE = 0.55;
const MINIMUM_P99_SAMPLE_COUNT = 100;
const ATOMIC_COMMIT_MAX_MS = 1_000 / 60;

declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

const refreshRate = readRefreshRate();

export const INTERACTION_REFRESH_PROFILE = Object.freeze({
  refreshRate,
  frameDurationMs: 1_000 / refreshRate,
  atomicCommitMaxMs: ATOMIC_COMMIT_MAX_MS,
  interruptibleSliceDeadlineMs: (1_000 / refreshRate) * MAIN_THREAD_FRAME_SHARE,
  mainThreadP99Ms: (1_000 / refreshRate) * MAIN_THREAD_FRAME_SHARE,
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

export function measureInteractionFrames(
  run: (frame: number) => void,
  count: number = INTERACTION_REFRESH_PROFILE.sampleCount,
): number[] {
  if (!Number.isInteger(count) || count < 0 || count > 0xffff_ffff) {
    throw new RangeError("Invalid interaction frame count.");
  }
  const durations = new Array<number>(count);
  for (let frame = 0; frame < count; frame += 1) {
    const startedAt = performance.now();
    run(frame);
    durations[frame] = performance.now() - startedAt;
  }
  return durations;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

export function interactionP99(values: readonly number[]): number {
  if (values.length < MINIMUM_P99_SAMPLE_COUNT) {
    throw new RangeError(
      `Interaction p99 requires at least ${MINIMUM_P99_SAMPLE_COUNT} samples; received ${values.length}.`,
    );
  }
  return percentile(values, 0.99);
}

export function interactionProfileAnnotation(label: string, p99: number): string {
  return (
    `${label}: p99=${p99.toFixed(3)} ms, ` +
    `refreshRate=${INTERACTION_REFRESH_PROFILE.refreshRate} Hz, ` +
    `target=${INTERACTION_REFRESH_PROFILE.mainThreadP99Ms.toFixed(1)} ms, ` +
    `frame=${INTERACTION_REFRESH_PROFILE.frameDurationMs.toFixed(3)} ms`
  );
}
