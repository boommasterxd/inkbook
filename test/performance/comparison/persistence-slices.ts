export interface SliceResult<T = unknown> {
  readonly value: T;
  readonly samples: readonly number[];
}

export async function measureSlices<T>(
  operation: (checkpoint: () => Promise<void>) => Promise<T>,
): Promise<SliceResult<T>> {
  const samples: number[] = [];
  let started = performance.now();
  const value = await operation(async () => {
    samples.push(performance.now() - started);
    await Promise.resolve();
    started = performance.now();
  });
  samples.push(performance.now() - started);
  return { value, samples };
}

export function sliceSamples(result: unknown): readonly number[] {
  return (result as SliceResult).samples;
}
