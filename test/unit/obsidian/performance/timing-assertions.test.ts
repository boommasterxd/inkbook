import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectTiming } from "../../../performance/timing-assertions";
import { timingBudget } from "../../../performance/timing-budget";

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
  writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  flushCallbacks.forEach((callback) => callback());
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function flushRecords(): Record<string, unknown>[] {
  flushCallbacks.forEach((callback) => callback());
  const output = writeSpy.mock.lastCall?.[0];
  expect(typeof output).toBe("string");
  return JSON.parse(String(output).replace(/^INKBOOK_TIMING_RECORDS /, "")) as Record<
    string,
    unknown
  >[];
}

describe("performance timing assertions", () => {
  it("records successful measurements with original and effective budgets", () => {
    vi.stubEnv("INKBOOK_PERFORMANCE_PROFILE", "hosted-ubuntu");
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

  it("rejects overflow in the effective hosted budget", () => {
    vi.stubEnv("INKBOOK_PERFORMANCE_PROFILE", "hosted-ubuntu");
    expect(() => expectTiming(1, Number.MAX_VALUE)).toThrow(TypeError);
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

  it("resets record and ordinal storage after flushing", () => {
    expectTiming(0, 1);
    flushRecords();
    expectTiming(0, 1);
    expect(flushRecords()).toEqual([expect.objectContaining({ ordinal: 1 })]);
  });
});
