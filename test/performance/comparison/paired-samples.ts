export function checkedSamples(samples: readonly number[]): readonly number[] {
  if (
    !Array.isArray(samples) ||
    samples.length === 0 ||
    samples.length > 1_000_000 ||
    samples.some((sample) => !Number.isFinite(sample) || sample < 0)
  )
    throw new Error("Comparison kernel returned invalid wall-clock measurements.");
  return samples as readonly number[];
}

export function sumOperationWork(samples: readonly number[]): number {
  const workMs = samples.reduce((total, sample) => total + sample, 0);
  if (!Number.isFinite(workMs))
    throw new Error("Comparison operation work exceeded numeric bounds.");
  return workMs;
}

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}
