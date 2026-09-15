import { afterAll, expect } from "vitest";

import { performanceMode, timingBudget } from "./timing-budget";

declare const process: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stderr: { write(this: void, chunk: string): boolean };
};

interface TimingOptions {
  readonly soft?: boolean;
  readonly exclusive?: boolean;
  readonly label?: string;
}

interface TimingRecord {
  readonly testName: string;
  readonly testPath: string;
  readonly ordinal: number;
  readonly actualMs: number;
  readonly referenceMs: number;
  readonly limitMs: number;
  readonly ratio: number;
  readonly refreshRate: number;
  readonly comparison: "lt" | "lte";
  readonly label?: string;
}

const MAXIMUM_RECORDS = 20_000;
const records: TimingRecord[] = [];
const ordinals = new Map<string, number>();

afterAll(() => {
  performanceMode();
  if (process.env["INKBOOK_PERFORMANCE_REPORT"] === "1") {
    const { testPath } = expect.getState();
    if (!testPath) throw new TypeError("Timing reports require an owning test file.");
    const report = { testPath, measurements: records };
    process.stderr.write(`INKBOOK_TIMING_RECORDS ${JSON.stringify(report)}\n`);
  }
  records.length = 0;
  ordinals.clear();
});

export function expectTiming(
  actualMs: number,
  referenceMs: number,
  options: TimingOptions = {},
): void {
  const limitMs = timingBudget(referenceMs);
  if (
    !Number.isFinite(actualMs) ||
    actualMs < 0 ||
    !Number.isFinite(referenceMs) ||
    referenceMs <= 0 ||
    !Number.isFinite(limitMs) ||
    !Number.isFinite(actualMs / referenceMs)
  ) {
    throw new TypeError(
      "Timing assertions require finite, nonnegative measurements and positive budgets.",
    );
  }
  if (process.env["INKBOOK_PERFORMANCE_REPORT"] === "1") {
    recordTiming(actualMs, referenceMs, limitMs, options);
  }
  if (performanceMode() !== "reference") return;
  const assertion = options.soft
    ? expect.soft(actualMs, options.label)
    : expect(actualMs, options.label);
  if (options.exclusive) assertion.toBeLessThan(limitMs);
  else assertion.toBeLessThanOrEqual(limitMs);
}

function recordTiming(
  actualMs: number,
  referenceMs: number,
  limitMs: number,
  options: TimingOptions,
): void {
  if (records.length >= MAXIMUM_RECORDS) {
    throw new RangeError("Performance timing telemetry exceeded 20000 records.");
  }
  const refreshRate = Number(process.env["INKBOOK_PERFORMANCE_REFRESH_RATE"]);
  const { currentTestName: testName, testPath } = expect.getState();
  if (!testName || !testPath || ![60, 90, 120, 144, 240].includes(refreshRate)) {
    throw new TypeError("Timing telemetry requires a running test and a supported refresh rate.");
  }
  const key = JSON.stringify([testPath, testName]);
  const ordinal = (ordinals.get(key) ?? 0) + 1;
  ordinals.set(key, ordinal);
  records.push({
    testName,
    testPath,
    ordinal,
    actualMs,
    referenceMs,
    limitMs,
    ratio: actualMs / referenceMs,
    refreshRate,
    comparison: options.exclusive ? "lt" : "lte",
    ...(options.label === undefined ? {} : { label: options.label }),
  });
}
