import { describe, expect, it } from "vitest";

import { parseTimingRecords } from "../../../scripts/performance-results.mjs";

const record = {
  testName: "measured operation",
  testPath: "/test.test.ts",
  ordinal: 1,
  actualMs: 4,
  referenceMs: 2,
  limitMs: 10,
  ratio: 2,
  refreshRate: 240,
  comparison: "lte",
};
const report = (records) =>
  `worker diagnostic\nINKBOOK_TIMING_RECORDS ${JSON.stringify(records)}\n`;

describe("performance measurement reports", () => {
  it("retains successful and failed measurements independently of the test exit code", () => {
    const failed = { ...record, actualMs: 12, ratio: 6, ordinal: 2, comparison: "lt" };
    expect(parseTimingRecords(report([record, failed]))).toEqual([record, failed]);
    expect(parseTimingRecords(report([]))).toEqual([]);
  });

  it("rejects absent, duplicate, malformed, and excessive telemetry", () => {
    expect(() => parseTimingRecords("worker crashed")).toThrow("exactly one");
    expect(() => parseTimingRecords(report([]) + report([]))).toThrow("exactly one");
    expect(() => parseTimingRecords("INKBOOK_TIMING_RECORDS {\n")).toThrow();
    expect(() => parseTimingRecords(report(Array.from({ length: 20_001 }, () => record)))).toThrow(
      "size",
    );
  });

  it.each([
    { actualMs: -1 },
    { referenceMs: 0 },
    { limitMs: 0 },
    { ratio: 99 },
    { ordinal: 0 },
    { refreshRate: 75 },
    { comparison: "unknown" },
    { testName: null },
  ])("rejects invalid measurements: %j", (override) => {
    expect(() => parseTimingRecords(report([{ ...record, ...override }]))).toThrow("measurement");
  });
});
