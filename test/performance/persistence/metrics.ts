import { expectTiming } from "../timing-assertions";

declare const gc: (() => void) | undefined;

export interface MeasuredOperation<T> {
  readonly durationMs: number;
  readonly value: T;
}

export interface DurationSummary {
  readonly maximum: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number | null;
}

export type MetricAnnotator = (message: string, type?: string) => Promise<unknown>;

export function measure<T>(operation: () => T): MeasuredOperation<T> {
  const start = performance.now();
  const value = operation();
  return { durationMs: performance.now() - start, value };
}

export async function measureAsync<T>(operation: () => Promise<T>): Promise<MeasuredOperation<T>> {
  const start = performance.now();
  const value = await operation();
  return { durationMs: performance.now() - start, value };
}

export function summarizeDurations(durations: readonly number[]): DurationSummary {
  if (durations.length === 0) throw new Error("A performance summary requires measured runs.");
  const sorted = [...durations].sort((left, right) => left - right);
  return {
    maximum: sorted[sorted.length - 1]!,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: sorted.length >= 100 ? percentile(sorted, 0.99) : null,
  };
}

export function expectProfileBudget(durations: readonly number[], desktopBudgetMs: number): void {
  expectTiming(summarizeDurations(durations).maximum, desktopBudgetMs, { soft: true });
}

export async function annotateDurations(
  annotate: MetricAnnotator,
  name: string,
  durations: readonly number[],
): Promise<void> {
  const summary = summarizeDurations(durations);
  await annotate(
    `${name}: p50=${format(summary.p50)} ms, p95=${format(summary.p95)} ms, ` +
      `${formatP99(summary.p99)}, max=${format(summary.maximum)} ms`,
    "performance",
  );
}

export async function annotateProfileRuns(
  annotate: MetricAnnotator,
  name: string,
  runs: readonly (readonly number[])[],
): Promise<void> {
  if (runs.length === 0) throw new Error("A performance profile requires measured runs.");
  for (let index = 0; index < runs.length; index += 1) {
    await annotateDurations(annotate, `${name} run ${index + 1}`, runs[index]!);
  }
  const summaries = runs.map(summarizeDurations);
  const worstRun = summaries.reduce(
    (worst, candidate, index) =>
      candidate.maximum > worst.summary.maximum ? { index, summary: candidate } : worst,
    { index: 0, summary: summaries[0]! },
  );
  await annotate(
    `${name}: worstRun=${worstRun.index + 1}, p50=${format(worstRun.summary.p50)} ms, ` +
      `p95=${format(worstRun.summary.p95)} ms, ${formatP99(worstRun.summary.p99)}, ` +
      `max=${format(worstRun.summary.maximum)} ms`,
    "performance",
  );
}

export function expectProfileRunsBudget(
  runs: readonly (readonly number[])[],
  desktopBudgetMs: number,
): void {
  for (const run of runs) {
    expectTiming(summarizeDurations(run).p95, desktopBudgetMs, { soft: true });
  }
}

export function collectProfileGarbage(): void {
  if (typeof gc !== "function") {
    throw new Error("Performance profiles require Node.js with --expose-gc.");
  }
  gc();
}

function percentile(sorted: readonly number[], quantile: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index]!;
}

function format(value: number): string {
  return value.toFixed(3);
}

function formatP99(value: number | null): string {
  return value === null ? "p99=n/a (<100 samples)" : `p99=${format(value)} ms`;
}
