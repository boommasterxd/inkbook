export interface Distribution {
  readonly maximum: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number | null;
  readonly sampleCount: number;
}

export function percentile(values: readonly number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] as number;
}

export function distribution(values: readonly number[]): Distribution {
  return {
    maximum: Math.max(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: values.length >= 100 ? percentile(values, 0.99) : null,
    sampleCount: values.length,
  };
}

export function worstDistribution(values: readonly Distribution[]): Distribution {
  const p99Values = values.flatMap(({ p99 }) => (p99 === null ? [] : [p99]));
  return {
    maximum: Math.max(...values.map(({ maximum }) => maximum)),
    p50: Math.max(...values.map(({ p50 }) => p50)),
    p95: Math.max(...values.map(({ p95 }) => p95)),
    p99: p99Values.length === values.length ? Math.max(...p99Values) : null,
    sampleCount: values[0]?.sampleCount ?? 0,
  };
}
