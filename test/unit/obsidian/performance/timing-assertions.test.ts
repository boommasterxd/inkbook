import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectTiming, recordRelativeTiming } from "../../../performance/timing-assertions";
import { performanceMode, timingBudget } from "../../../performance/timing-budget";

declare const process: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stderr: { write(this: void, chunk: string): boolean };
};

const { flushCallbacks } = vi.hoisted(() => ({ flushCallbacks: [] as (() => void)[] }));

vi.mock("vitest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vitest")>()),
  afterAll: (callback: () => void) => flushCallbacks.push(callback),
}));

let writeSpy: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  vi.stubEnv("INKBOOK_PERFORMANCE_REPORT", "1");
  vi.stubEnv("INKBOOK_PERFORMANCE_REFRESH_RATE", "240");
  vi.stubEnv("INKBOOK_PERFORMANCE_PROFILE", undefined);
  vi.stubEnv("INKBOOK_PERFORMANCE_MODE", undefined);
  writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.stubEnv("INKBOOK_PERFORMANCE_PROFILE", undefined);
  vi.stubEnv("INKBOOK_PERFORMANCE_MODE", undefined);
  flushCallbacks.forEach((callback) => callback());
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function flushRecords(): Record<string, unknown>[] {
  flushCallbacks.forEach((callback) => callback());
  const output = writeSpy.mock.lastCall?.[0];
  expect(typeof output).toBe("string");
  const report = JSON.parse(String(output).replace(/^INKBOOK_TIMING_RECORDS /, "")) as {
    testPath: string;
    measurements: Record<string, unknown>[];
  };
  expect(report.testPath).toContain("timing-assertions.test.ts");
  return report.measurements;
}

describe("performance timing assertions", () => {
  it("records successful measurements with original and effective budgets", () => {
    expectTiming(0.2, 1, { label: "dispatch" });
    expectTiming(0.3, 1, { exclusive: true });
    const captured = flushRecords();
    expect(captured[0]?.["testName"]).toContain("records successful measurements");
    expect(captured[0]?.["testPath"]).toContain("timing-assertions.test.ts");
    expect(captured).toEqual([
      expect.objectContaining({
        actualMs: 0.2,
        referenceMs: 1,
        limitMs: timingBudget(1),
        ratio: 0.2,
        refreshRate: 240,
        ordinal: 1,
        comparison: "lte",
        label: "dispatch",
      }),
      expect.objectContaining({ ordinal: 2, comparison: "lt" }),
    ]);
  });

  it("preserves inclusive and strict boundary comparisons", () => {
    expectTiming(1, 1);
    expect(() => expectTiming(1, 1, { exclusive: true })).toThrow();
    expect(() => expectTiming(2, 1, { label: "over budget" })).toThrow("over budget");
    expect(flushRecords()).toHaveLength(3);
  });

  it.fails("preserves native soft failure and continues after the assertion", () => {
    expectTiming(2, 1, { soft: true });
    expect(flushRecords()).toHaveLength(1);
  });

  it("accepts successful soft assertions", () => {
    expectTiming(0, 1, { soft: true, exclusive: true });
    expect(flushRecords()).toHaveLength(1);
  });

  it.each([
    [NaN, 1],
    [Infinity, 1],
    [-1, 1],
    [1, 0],
    [1, -1],
    [1, NaN],
    [1, Infinity],
    [Number.MAX_VALUE, Number.MIN_VALUE],
  ])("rejects invalid measurement %s or budget %s", (actual, reference) => {
    expect(() => expectTiming(actual, reference)).toThrow(TypeError);
    expect(flushRecords()).toEqual([]);
  });

  it("rejects the removed hosted profile", () => {
    vi.stubEnv("INKBOOK_PERFORMANCE_PROFILE", "hosted-ubuntu");
    expect(() => expectTiming(1, Number.MAX_VALUE)).toThrow("Timing multipliers were removed");
  });

  it.each([undefined, "median", "p99"])("rejects obsolete statistic option %j", (statistic) => {
    const options = { label: "dispatch", statistic };
    expect(() => expectTiming(0.2, 1, options)).toThrow(TypeError);
    expect(flushRecords()).toEqual([]);
  });

  it("does not capture or emit records when telemetry is disabled", () => {
    vi.stubEnv("INKBOOK_PERFORMANCE_REPORT", undefined);
    vi.stubEnv("INKBOOK_PERFORMANCE_REFRESH_RATE", undefined);
    expectTiming(0, 1);
    flushCallbacks.forEach((callback) => callback());
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("rejects unsupported refresh rates when telemetry is enabled", () => {
    vi.stubEnv("INKBOOK_PERFORMANCE_REFRESH_RATE", "75");
    expect(() => expectTiming(0, 1)).toThrow("supported refresh rate");
  });

  it("rejects measurements beyond the bounded report capacity", () => {
    for (let index = 0; index < 20_000; index += 1) expectTiming(0, 1);
    expect(() => expectTiming(0, 1)).toThrow("exceeded 20000 records");
    expect(flushRecords()).toHaveLength(20_000);
  });
});

describe("performance timing modes", () => {
  it.each(["contracts", "measurement"])(
    "captures raw timings without absolute assertions in %s mode",
    (mode) => {
      vi.stubEnv("INKBOOK_PERFORMANCE_MODE", mode);
      expectTiming(100, 1, { exclusive: true });
      expect(flushRecords()).toEqual([
        expect.objectContaining({ actualMs: 100, referenceMs: 1, limitMs: 1 }),
      ]);
      expect(() => expectTiming(NaN, 1)).toThrow(TypeError);
    },
  );

  it("allows contracts mode without timing reports", () => {
    vi.stubEnv("INKBOOK_PERFORMANCE_MODE", "contracts");
    vi.stubEnv("INKBOOK_PERFORMANCE_REPORT", undefined);
    expectTiming(100, 1);
    flushCallbacks.forEach((callback) => callback());
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it.each(["", "hosted-ubuntu", "unknown", "compare"])("rejects unsupported mode %s", (mode) => {
    vi.stubEnv("INKBOOK_PERFORMANCE_MODE", mode);
    expect(() => expectTiming(0, 1)).toThrow("Unsupported performance mode");
    expect(() => flushCallbacks.forEach((callback) => callback())).toThrow(
      "Unsupported performance mode",
    );
  });

  it("identifies reports even when the file has no timing measurements", () => {
    expect(flushRecords()).toEqual([]);
  });

  it("keeps default and explicit reference budgets unscaled", () => {
    expect(performanceMode()).toBe("reference");
    expect(timingBudget(2.5)).toBe(2.5);
    vi.stubEnv("INKBOOK_PERFORMANCE_MODE", "reference");
    expect(timingBudget(2.5)).toBe(2.5);
  });

  it("resets record and ordinal storage after flushing", () => {
    expectTiming(0, 1);
    flushRecords();
    expectTiming(0, 1);
    expect(flushRecords()).toEqual([expect.objectContaining({ ordinal: 1 })]);
  });
});

describe("relative-only timing telemetry", () => {
  it.each(["reference", "contracts", "measurement"])(
    "records total work without inventing an absolute budget in %s mode",
    (mode) => {
      vi.stubEnv("INKBOOK_PERFORMANCE_MODE", mode);
      recordRelativeTiming(Number.MAX_VALUE, "total sliced work");
      expectTiming(0.2, 1);
      recordRelativeTiming(0, "empty work");
      expect(flushRecords()).toEqual([
        expect.objectContaining({
          actualMs: Number.MAX_VALUE,
          referenceMs: null,
          limitMs: null,
          ratio: null,
          comparison: "relative",
          label: "total sliced work",
          ordinal: 1,
        }),
        expect.objectContaining({ actualMs: 0.2, referenceMs: 1, ordinal: 2 }),
        expect.objectContaining({ actualMs: 0, comparison: "relative", ordinal: 3 }),
      ]);
    },
  );

  it.each([NaN, Infinity, -1])("rejects invalid elapsed work %s", (actualMs) => {
    expect(() => recordRelativeTiming(actualMs, "work")).toThrow(TypeError);
    expect(flushRecords()).toEqual([]);
  });

  it.each(["", "   "])("requires a nonempty descriptive label %j", (label) => {
    expect(() => recordRelativeTiming(1, label)).toThrow(TypeError);
    expect(flushRecords()).toEqual([]);
  });

  it("does not record when telemetry is disabled but still validates the mode", () => {
    vi.stubEnv("INKBOOK_PERFORMANCE_REPORT", undefined);
    recordRelativeTiming(10, "work");
    flushCallbacks.forEach((callback) => callback());
    expect(writeSpy).not.toHaveBeenCalled();
    vi.stubEnv("INKBOOK_PERFORMANCE_MODE", "unknown");
    expect(() => recordRelativeTiming(10, "work")).toThrow("Unsupported performance mode");
  });

  it("requires the same running test context and refresh rate as budgeted timing", () => {
    vi.stubEnv("INKBOOK_PERFORMANCE_REFRESH_RATE", "75");
    expect(() => recordRelativeTiming(1, "work")).toThrow("supported refresh rate");
    vi.stubEnv("INKBOOK_PERFORMANCE_REFRESH_RATE", "240");
    const state = expect.getState();
    vi.spyOn(expect, "getState").mockReturnValue({ ...state, currentTestName: "" });
    expect(() => recordRelativeTiming(1, "work")).toThrow("running test");
  });

  it("shares the bounded capacity and resets ordinals with all timing records", () => {
    for (let index = 0; index < 20_000; index += 1) recordRelativeTiming(1, "work");
    expect(() => expectTiming(0, 1)).toThrow("exceeded 20000 records");
    expect(() => recordRelativeTiming(1, "work")).toThrow("exceeded 20000 records");
    expect(flushRecords()).toHaveLength(20_000);
    recordRelativeTiming(1, "work");
    expect(flushRecords()[0]).toMatchObject({ ordinal: 1 });
  });
});
